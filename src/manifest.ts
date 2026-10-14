import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import type { MessageExport } from "./transform.js";

type ExportOperation =
  | { kind: "local"; exported: string; local: string }
  | { kind: "named"; source: string; elements: { exported: string; imported: string }[] }
  | { kind: "star"; source: string }
  | { kind: "namespace"; source: string; name: string };
/** Export statements of each generated module, reused while the file is unchanged. */
export type ManifestCache = Map<string, { version: string; operations: ExportOperation[] }>;

function scanExports(file: string, cache: ManifestCache): ExportOperation[] {
  let version: string;
  let code: string;
  try {
    const stat = fs.statSync(file, { bigint: true });
    version = `${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
    const cached = cache.get(file);
    if (cached?.version === version) return cached.operations;
    code = fs.readFileSync(file, "utf8");
  } catch (cause) {
    throw new Error(
      `[paraglide-sugar] Cannot read ${file}. Run Paraglide before paraglideSugar with outputStructure: 'message-modules'.`,
      { cause },
    );
  }
  const ast = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS);
  const diagnostics = (ast as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] })
    .parseDiagnostics;
  if (diagnostics.length) {
    throw new Error(
      `[paraglide-sugar] Invalid generated module ${file}: ${ts.flattenDiagnosticMessageText(diagnostics[0].messageText, "\n")}`,
    );
  }
  const operations: ExportOperation[] = [];
  for (const statement of ast.statements) {
    if (ts.isExportDeclaration(statement)) {
      if (statement.isTypeOnly) continue;
      const specifier = statement.moduleSpecifier;
      let source: string | undefined;
      if (specifier && ts.isStringLiteral(specifier)) {
        if (!specifier.text.startsWith(".")) {
          throw new Error(
            `[paraglide-sugar] Message re-exports must be local modules: ${specifier.text}`,
          );
        }
        source = path.resolve(path.dirname(file), specifier.text);
      }
      if (!statement.exportClause) {
        if (source) operations.push({ kind: "star", source });
      } else if (ts.isNamedExports(statement.exportClause)) {
        const elements = statement.exportClause.elements
          .filter((element) => !element.isTypeOnly)
          .map((element) => ({
            exported: element.name.text,
            imported: element.propertyName?.text ?? element.name.text,
          }));
        if (source) operations.push({ kind: "named", source, elements });
        else {
          for (const { exported, imported } of elements) {
            operations.push({ kind: "local", exported, local: imported });
          }
        }
      } else if (ts.isNamespaceExport(statement.exportClause) && source) {
        operations.push({ kind: "namespace", source, name: statement.exportClause.name.text });
      }
    } else if (
      ts.canHaveModifiers(statement) &&
      ts.getModifiers(statement)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name)) {
            const name = declaration.name.text;
            operations.push({ kind: "local", exported: name, local: name });
          }
        }
      } else if (
        (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) &&
        statement.name
      ) {
        const name = statement.name.text;
        operations.push({ kind: "local", exported: name, local: name });
      }
    }
  }
  cache.set(file, { version, operations });
  return operations;
}

/**
 * Read real ESM exports; Paraglide file stems are not message identifiers.
 * Pass the same cache to later calls to parse only modules that changed.
 */
export function readMessageManifest(
  entryFile: string,
  cache: ManifestCache = new Map(),
): Map<string, MessageExport> {
  type ResolvedExport = { message: MessageExport; binding: string };
  // An ambiguous name must survive through parent star exports, even though it
  // will not be exposed in the final message manifest.
  type ModuleExports = Map<string, ResolvedExport | undefined>;
  const resolved = new Map<string, ModuleExports>();
  const active = new Set<string>();
  function read(file: string): ModuleExports {
    const cached = resolved.get(file);
    if (cached) return cached;
    if (active.has(file))
      throw new Error(`[paraglide-sugar] Circular message re-export in ${file}`);
    active.add(file);
    const entries: ModuleExports = new Map();
    const stars: ModuleExports = new Map();
    const namespaces = new Map<string, ModuleExports>();
    const direct = (name: string, localName: string): ResolvedExport => ({
      message: { source: file.split(path.sep).join("/"), exportName: name },
      // Different exported aliases can identify the same local binding. Comparing
      // export names would incorrectly reject valid diamond re-exports.
      binding: `${file}\0${localName}`,
    });
    for (const operation of scanExports(file, cache)) {
      if (operation.kind === "local") {
        entries.set(operation.exported, direct(operation.exported, operation.local));
      } else if (operation.kind === "star") {
        for (const [key, value] of read(operation.source)) {
          if (key === "default") continue;
          if (!stars.has(key)) stars.set(key, value);
          else if (stars.get(key)?.binding !== value?.binding) stars.set(key, undefined);
        }
      } else if (operation.kind === "named") {
        const child = read(operation.source);
        for (const { exported, imported } of operation.elements) {
          const entry = child.get(imported);
          if (!entry) {
            throw new Error(
              `[paraglide-sugar] Missing export ${JSON.stringify(imported)} re-exported by ${file}`,
            );
          }
          entries.set(exported, entry);
        }
      } else {
        // Recent Paraglide versions also expose `export * as m`. The
        // namespace is a container, never a callable message identifier.
        namespaces.set(operation.name, read(operation.source));
      }
    }
    // Explicit exports take precedence regardless of declaration order. Namespace
    // exports are explicit too, but are not callable message entries.
    for (const [key, value] of stars) {
      if (!entries.has(key) && !namespaces.has(key)) entries.set(key, value);
    }
    if (!entries.size && namespaces.size) {
      if (namespaces.size !== 1) {
        throw new Error(`[paraglide-sugar] Ambiguous namespace-only message barrel in ${file}`);
      }
      for (const [key, entry] of namespaces.values().next().value!) entries.set(key, entry);
    }
    if (
      !entries.size &&
      path.resolve(file) !== path.resolve(entryFile) &&
      path.basename(file) !== "_index.js"
    ) {
      throw new Error(`[paraglide-sugar] Generated message module has no exports yet: ${file}`);
    }
    active.delete(file);
    resolved.set(file, entries);
    return entries;
  }
  const messages = new Map<string, MessageExport>();
  for (const [key, entry] of read(path.resolve(entryFile))) {
    if (entry) messages.set(key, entry.message);
  }
  // Importing a locale-module barrel cannot provide the route-level splitting
  // promised by this plugin. Fail clearly instead of silently losing that benefit.
  for (const entry of messages.values()) {
    if (
      path.resolve(entry.source) === path.resolve(entryFile) ||
      path.basename(entry.source) === "_index.js"
    ) {
      throw new Error(
        `[paraglide-sugar] ${entryFile} must use Paraglide outputStructure: 'message-modules'.`,
      );
    }
  }
  // Forget modules that the catalog no longer references.
  for (const file of cache.keys()) if (!resolved.has(file)) cache.delete(file);
  return messages;
}
