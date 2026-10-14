import fs from "node:fs";
import path from "node:path";
import { parse, type TSESTree } from "@typescript-eslint/typescript-estree";
import type { Plugin, ViteDevServer } from "vite";
import { readMessageManifest, type ManifestCache } from "./manifest.js";
import { mayImportMarker, transformMessages, type MessageManifest } from "./transform.js";

export type ParaglideSugarOptions = {
  /** App and shared workspace source roots, relative to the Vite root. */
  sourceRoots?: readonly string[];
  /** Exact module specifier used to import the typed message marker. */
  importSource: string;
  /** Named marker export. Defaults to m. */
  exportName?: string;
  /** Unknown static keys fail the build by default. */
  missingKey?: "error" | "undefined";
  /** Generated message entry relative to outdir; otherwise detected automatically. */
  messagesEntry?: string;
  /** This app's generated Paraglide directory, relative to the Vite root. */
  outdir: string;
};

const groupPrefix = "virtual:paraglide-sugar/messages/";
const resolvedGroupPrefix = `\0${groupPrefix}`;
const extensions = /\.(?:svelte|[cm]?[jt]s|[jt]sx)$/;
const normalize = (file: string) => file.split(path.sep).join("/");

export function paraglideSugar(options: ParaglideSugarOptions): Plugin {
  if (!options || typeof options.outdir !== "string" || !options.outdir.trim())
    throw new Error("[paraglide-sugar] outdir must name the generated Paraglide directory.");
  if (typeof options.importSource !== "string" || !options.importSource.trim())
    throw new Error("[paraglide-sugar] importSource must name the message marker module.");
  if (options.exportName !== undefined && !options.exportName.trim())
    throw new Error("[paraglide-sugar] exportName must be nonempty.");
  if (options.missingKey !== undefined && !["error", "undefined"].includes(options.missingKey))
    throw new Error("[paraglide-sugar] missingKey must be error or undefined.");
  const sourceRoots = options.sourceRoots ?? ["src"];
  if (!sourceRoots.length || sourceRoots.some((root) => typeof root !== "string" || !root.trim()))
    throw new Error("[paraglide-sugar] sourceRoots must contain at least one source directory.");
  let generatedDirectory = path.resolve(options.outdir);
  let roots = sourceRoots.map((root) => normalize(path.resolve(root)) + "/");
  let generatedRoot = normalize(generatedDirectory) + "/";
  let root = process.cwd();
  let indexFile = path.join(generatedDirectory, options.messagesEntry ?? "messages.js");
  let messages: MessageManifest | undefined;
  const scans: ManifestCache = new Map();
  const transformed = new Set<string>();
  const groups = new Set<string>();
  // Resolved ids of the marker module, checked for leftover runtime importers.
  const markers = new Set<string>();
  let server: ViteDevServer | undefined;
  let updateTimer: ReturnType<typeof setTimeout> | undefined;
  let pendingUpdate: Promise<void> | undefined;
  let finishUpdate: (() => void) | undefined;
  let failUpdate: ((error: Error) => void) | undefined;
  let refreshAttempts = 0;
  let disposeWatcher: (() => void) | undefined;

  function manifest() {
    if (!messages) {
      indexFile = options.messagesEntry
        ? path.resolve(generatedDirectory, options.messagesEntry)
        : fs.existsSync(path.join(generatedDirectory, "messages.js"))
          ? path.join(generatedDirectory, "messages.js")
          : path.join(generatedDirectory, "messages/_index.js");
      messages = readMessageManifest(indexFile, scans);
    }
    return messages;
  }
  function isGeneratedMessage(file: string) {
    const relative = path.relative(generatedDirectory, file);
    return (
      relative !== "" &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative) &&
      relative.endsWith(".js")
    );
  }
  function reload() {
    if (!server) return;
    // server.moduleGraph spans only the client and SSR environments. Custom
    // environments, such as worker runtimes, keep their own module graphs.
    for (const environment of Object.values(server.environments)) {
      for (const id of [...transformed, ...groups]) {
        const module = environment.moduleGraph.getModuleById(id);
        if (module) environment.moduleGraph.invalidateModule(module);
      }
    }
    for (const environment of Object.values(server.environments)) {
      environment.hot.send({ type: "full-reload", path: "*" });
    }
  }
  function refreshGeneratedMessages() {
    updateTimer = undefined;
    try {
      // The compiler writes its index and individual modules separately. Swap
      // the manifest only after every referenced module can be read and parsed.
      messages = readMessageManifest(indexFile, scans);
    } catch (cause) {
      if (++refreshAttempts < 30) {
        updateTimer = setTimeout(refreshGeneratedMessages, 100);
        return;
      }
      const error = cause instanceof Error ? cause : new Error(String(cause));
      messages = undefined;
      failUpdate?.(error);
      server?.ws.send({
        type: "error",
        err: { message: error.message, stack: error.stack ?? "" },
      });
      pendingUpdate = undefined;
      finishUpdate = undefined;
      failUpdate = undefined;
      return;
    }
    reload();
    finishUpdate?.();
    pendingUpdate = undefined;
    finishUpdate = undefined;
    failUpdate = undefined;
  }
  function scheduleRefresh(file: string) {
    if (!isGeneratedMessage(file)) return;
    if (updateTimer) clearTimeout(updateTimer);
    refreshAttempts = 0;
    if (!pendingUpdate) {
      pendingUpdate = new Promise<void>((resolve, reject) => {
        finishUpdate = resolve;
        failUpdate = reject;
      });
      // A refresh can fail without a transform currently waiting for it. The
      // dev-server error overlay still reports that failure.
      void pendingUpdate.catch(() => {});
    }
    updateTimer = setTimeout(refreshGeneratedMessages, 100);
  }
  function dispose() {
    if (updateTimer) clearTimeout(updateTimer);
    updateTimer = undefined;
    finishUpdate?.();
    pendingUpdate = undefined;
    finishUpdate = undefined;
    failUpdate = undefined;
    disposeWatcher?.();
    disposeWatcher = undefined;
  }

  return {
    name: "vite-plugin-paraglide-sugar",
    enforce: "pre",
    configResolved(config) {
      const modulePrefix = (directory: string) => {
        let resolved = path.resolve(config.root, directory);
        if (!config.resolve?.preserveSymlinks) {
          try {
            resolved = fs.realpathSync(resolved);
          } catch (error) {
            // Source directories may be generated after config resolution.
            const code = (error as NodeJS.ErrnoException).code;
            if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
          }
        }
        return normalize(resolved) + "/";
      };
      root = config.root;
      roots = sourceRoots.map(modulePrefix);
      // Paraglide output often sits inside a source root, such as src/lib/paraglide.
      generatedRoot = modulePrefix(options.outdir);
      generatedDirectory = path.resolve(config.root, options.outdir);
      indexFile = path.join(generatedDirectory, options.messagesEntry ?? "messages.js");
    },
    // Paraglide's buildStart compiles asynchronously. Waiting for preceding hooks
    // is required on a clean checkout, not just when generated files already exist.
    buildStart: {
      order: "post",
      sequential: true,
      async handler() {
        messages = undefined;
        transformed.clear();
        groups.clear();
        markers.clear();
        manifest();
        this.addWatchFile(indexFile);
        if (!server) {
          const marker = await this.resolve(options.importSource, path.join(root, "index.html"));
          if (marker) markers.add(marker.id);
        }
      },
    },
    // A marker import that the transform did not see, through another specifier
    // or from outside sourceRoots, builds successfully and then throws on its
    // first message read. The dev server and Vitest load modules on demand, so
    // there the access itself reports the problem.
    async buildEnd(error) {
      if (error || server) return;
      const exportName = options.exportName ?? "m";
      const named = (node: TSESTree.Identifier | TSESTree.StringLiteral) =>
        (node.type === "Identifier" ? node.name : node.value) === exportName;
      const leftovers: string[] = [];
      for (const marker of markers) {
        for (const importer of this.getModuleInfo(marker)?.importers ?? []) {
          const code = this.getModuleInfo(importer)?.code;
          if (!code) continue;
          let body;
          try {
            body = parse(code, { jsDocParsingMode: "none" }).body;
          } catch {
            continue;
          }
          for (const statement of body) {
            // Find runtime imports and re-exports that expose the message object.
            let source: string | undefined;
            if (statement.type === "ImportDeclaration") {
              if (
                statement.specifiers.some(
                  (specifier) =>
                    specifier.type === "ImportNamespaceSpecifier" ||
                    (specifier.type === "ImportSpecifier" && named(specifier.imported)),
                )
              )
                source = statement.source.value;
            } else if (statement.type === "ExportNamedDeclaration") {
              if (statement.specifiers.some((specifier) => named(specifier.local)))
                source = statement.source?.value;
            } else if (statement.type === "ExportAllDeclaration") {
              source = statement.source.value;
            }
            if (source === undefined || (await this.resolve(source, importer))?.id !== marker)
              continue;
            const file = path.relative(root, importer.split("?", 1)[0]).split(path.sep).join("/");
            leftovers.push(`${file} imports from ${JSON.stringify(source)}`);
          }
        }
      }
      if (leftovers.length) {
        this.error(
          `[paraglide-sugar] The message object ${JSON.stringify(exportName)} is still imported at runtime, so its reads were not compiled and would throw "Uncompiled message access":\n${leftovers.map((line) => `  - ${line}`).join("\n")}\nImport it as ${JSON.stringify(options.importSource)} (the exact importSource) from a file inside sourceRoots (${sourceRoots.join(", ")}).`,
        );
      }
    },
    configureServer(devServer) {
      server = devServer;
      server.watcher.on("add", scheduleRefresh);
      server.watcher.on("unlink", scheduleRefresh);
      server.watcher.add(generatedDirectory);
      disposeWatcher = () => {
        devServer.watcher.off("add", scheduleRefresh);
        devServer.watcher.off("unlink", scheduleRefresh);
      };
      server.httpServer?.once("close", dispose);
    },
    handleHotUpdate(context) {
      if (!isGeneratedMessage(context.file)) return;
      scheduleRefresh(context.file);
      return [];
    },
    watchChange(id) {
      if (!isGeneratedMessage(id)) return;
      if (server) scheduleRefresh(id);
      else messages = undefined;
    },
    closeBundle: dispose,
    resolveId(id) {
      if (!id.startsWith(groupPrefix)) return;
      const prefix = id.slice(groupPrefix.length);
      if (!prefix || !/^[\p{L}\p{N}_.$-]+$/u.test(prefix)) {
        this.error(
          "[paraglide-sugar] A virtual message group needs a nonempty literal key prefix.",
        );
      }
      return `\0${id}`;
    },
    async load(id) {
      if (!id.startsWith(resolvedGroupPrefix)) return;
      await pendingUpdate;
      groups.add(id);
      this.addWatchFile(indexFile);
      const prefix = id.slice(resolvedGroupPrefix.length);
      const imports: string[] = [];
      const properties: string[] = [];
      for (const [key, entry] of manifest()) {
        if (!key.startsWith(prefix)) continue;
        const local = `message_${properties.length}`;
        imports.push(
          `import { ${JSON.stringify(entry.exportName)} as ${local} } from ${JSON.stringify(entry.source)};`,
        );
        properties.push(`[${JSON.stringify(key)}]: ${local}`);
      }
      return `${imports.join("\n")}\nexport const messages = Object.assign(Object.create(null), {${properties.join(",\n")}});`;
    },
    async transform(code, id) {
      const [file, query = ""] = id.split("?", 2);
      const parameters = new URLSearchParams(query);
      const normalized = normalize(file);
      if (
        ["raw", "url", "worker", "sharedworker", "svelte"].some((key) => parameters.has(key)) ||
        !extensions.test(file) ||
        !roots.some((root) => normalized.startsWith(root)) ||
        normalized.startsWith(generatedRoot)
      )
        return null;
      if (!mayImportMarker(code, options.importSource)) return null;
      await pendingUpdate;
      // Worker entry requests contain ?worker_file&type=module. They still
      // carry source code; the parser needs the underlying filename/extension.
      let result;
      try {
        result = transformMessages(code, file, manifest(), options);
      } catch (error) {
        const pos = (error as { pos?: unknown }).pos;
        // Reporting with the source offset adds a code frame in Vite's output.
        if (typeof pos === "number") this.error(error as Error, pos);
        throw error;
      }
      if (result) {
        transformed.add(id);
        this.addWatchFile(indexFile);
        if (!server) {
          // The specifier can resolve differently per importer, such as through
          // package imports or per-directory tsconfig paths.
          const marker = await this.resolve(options.importSource, id);
          if (marker) markers.add(marker.id);
        }
        for (const { key, position } of result.missing) {
          this.warn({
            message: `[paraglide-sugar] Unknown message key ${JSON.stringify(key)}; preserving the undefined fallback.`,
            id,
            pos: position,
          });
        }
        return { code: result.code, map: result.map };
      }
      return null;
    },
  };
}

export default paraglideSugar;
