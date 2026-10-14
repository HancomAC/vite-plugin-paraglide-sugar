import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { compile } from "svelte/compiler";
import { build, type Plugin } from "vite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readMessageManifest } from "../src/manifest.js";
import { paraglideSugar } from "../src/vite.js";
import { compileCatalog } from "./fixtures/compile-catalog.mjs";

const temporaryDirectories: string[] = [];
const packageRoot = path.resolve(import.meta.dirname, "..");

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "paraglide-sugar-"));
  temporaryDirectories.push(root);
  const outdir = path.join(root, "generated");
  const indexFile = path.join(outdir, "messages/_index.js");
  const files: Record<string, string> = {
    "hello.js": `import { getLocale } from '../runtime.js'; export const hello = () => getLocale() === 'ko' ? '안녕' : 'Hello';`,
    "welcome.js": `import { getLocale } from '../runtime.js'; export const welcome = ({ name }, options = {}) => (options.locale ?? getLocale()) + ':' + name;`,
    "footer.terms.js": `const label = () => 'Terms'; export { label as 'footer.terms' };`,
    "statusmixedcase3.js": `export const status_MixedCase = () => 'Mixed case';`,
    "color_red.js": `export const color_red = () => 'Red';`,
    "color_blue.js": `export const color_blue = () => 'Blue';`,
    "lazy_only.js": `export const lazy_only = () => 'LAZY_TRANSLATION_SENTINEL';`,
    "unused.js": `export const unused = () => 'UNUSED_TRANSLATION_SENTINEL';`,
  };
  async function write(relative: string, contents: string) {
    const filename = path.resolve(root, relative);
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, contents);
    return filename;
  }
  async function writeMessages() {
    await Promise.all(
      Object.entries(files).map(([filename, contents]) =>
        write(`generated/messages/${filename}`, contents),
      ),
    );
    await write(
      "generated/messages/_index.js",
      Object.keys(files)
        .map((filename) => `export * from './${filename}';`)
        .join("\n"),
    );
  }
  await write("package.json", '{ "type": "module" }');
  await write(
    "generated/runtime.js",
    `
		import { AsyncLocalStorage } from 'node:async_hooks';
		const requestLocale = new AsyncLocalStorage();
		let locale = 'ko';
		export const getLocale = () => requestLocale.getStore() ?? locale;
		export const setLocale = (value) => { locale = value; };
		export const withLocale = (locale, run) => requestLocale.run(locale, run);
	`,
  );
  await write(
    "src/i18n.js",
    `export const m = new Proxy({}, { get() { throw new Error('Runtime catalog access'); } });`,
  );
  await symlink(path.join(packageRoot, "node_modules"), path.join(root, "node_modules"), "dir");
  await writeMessages();
  return { root, outdir, indexFile, files, write, writeMessages };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

function pluginHarness(f: Fixture, options: Partial<Parameters<typeof paraglideSugar>[0]> = {}) {
  const plugin = paraglideSugar({
    sourceRoots: ["src", "packages/ui/src"],
    outdir: "generated",
    importSource: "#translations",
    ...options,
  });
  const context = {
    addWatchFile: vi.fn(),
    warn: vi.fn(),
    error: (message: string): never => {
      throw new Error(message);
    },
  };
  function call(name: keyof Plugin, ...args: unknown[]) {
    const hook = plugin[name];
    const handler =
      typeof hook === "function"
        ? hook
        : hook && typeof hook === "object" && "handler" in hook
          ? hook.handler
          : undefined;
    return typeof handler === "function"
      ? (handler as (...args: any[]) => any).apply(context, args)
      : undefined;
  }
  call("configResolved", { root: f.root, command: "serve" });
  return { plugin, context, call };
}

async function bundle(
  f: Fixture,
  entry: string,
  beforePlugins: Plugin[] = [],
  options: Partial<Parameters<typeof paraglideSugar>[0]> = {},
) {
  const result = await build({
    configFile: false,
    root: f.root,
    logLevel: "silent",
    plugins: [
      ...beforePlugins,
      paraglideSugar({
        sourceRoots: ["src", "packages/ui/src"],
        outdir: "generated",
        importSource: "#translations",
        ...options,
      }),
      {
        name: "compile-i18n-test-components",
        transform(code, id) {
          if (id.endsWith(".svelte")) return compile(code, { filename: id, generate: "server" }).js;
        },
      },
    ],
    resolve: {
      alias: {
        "vite-plugin-paraglide-sugar/runtime": path.join(packageRoot, "src/runtime.ts"),
        "#translations": path.join(f.root, "src/i18n.js"),
      },
    },
    ssr: { noExternal: true },
    build: {
      ssr: entry,
      write: false,
      minify: false,
      sourcemap: true,
      rollupOptions: { external: [/^node:/], output: { format: "es" } },
    },
  });
  const outputs = Array.isArray(result) ? result : [result];
  return outputs.flatMap((output) =>
    "output" in output ? output.output.filter((item) => item.type === "chunk") : [],
  );
}

async function importBundle(code: string) {
  return import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
}

describe("generated message export discovery", () => {
  it("preserves dotted and underscore keys and reads identifiers independently from filenames", async () => {
    const f = await fixture();
    await f.write(
      "generated/messages/_index.js",
      `
			export * from './hello.js';
			export * from './footer.terms.js';
			export * from './statusmixedcase3.js';
			export { status_MixedCase as renamed_status } from './statusmixedcase3.js';
		`,
    );
    const manifest = readMessageManifest(f.indexFile);
    expect([...manifest.keys()].sort()).toEqual([
      "footer.terms",
      "hello",
      "renamed_status",
      "status_MixedCase",
    ]);
    expect(manifest.get("footer.terms")).toEqual({
      source: path.join(f.outdir, "messages/footer.terms.js"),
      exportName: "footer.terms",
    });
    expect(manifest.get("renamed_status")).toEqual({
      source: path.join(f.outdir, "messages/statusmixedcase3.js"),
      exportName: "status_MixedCase",
    });
    expect(manifest.has("footer_terms")).toBe(false);
    expect(manifest.has("statusmixedcase3")).toBe(false);
  });

  it("follows nested export barrels to the defining message module", async () => {
    const f = await fixture();
    await f.write("generated/messages/group.js", `export { hello as greeting } from './hello.js';`);
    await f.write("generated/messages/_index.js", `export * from './group.js';`);
    expect(readMessageManifest(f.indexFile).get("greeting")).toEqual({
      source: path.join(f.outdir, "messages/hello.js"),
      exportName: "hello",
    });
  });

  it("reports missing generated output and incompatible locale-module output clearly", async () => {
    const f = await fixture();
    await rm(f.indexFile);
    expect(() => readMessageManifest(f.indexFile)).toThrow(/Paraglide.*message-modules/i);
    await f.write("generated/messages/_index.js", `export const hello = () => 'Hello';`);
    expect(() => readMessageManifest(f.indexFile)).toThrow(/message-modules/);
  });
});

describe("Vite message transform lifecycle", () => {
  it("uses the configured import and export names and diagnoses unknown keys by default", async () => {
    const f = await fixture();
    const { call } = pluginHarness(f, { exportName: "text" });
    const id = path.join(f.root, "src/entry.ts");
    const result = await call(
      "transform",
      `import { text as t } from '#translations'; export const value = t.hello;`,
      id,
    );
    expect(result.code).toContain("messages/hello.js");
    expect(result.code).not.toContain("#translations");
    await expect(
      call(
        "transform",
        `import { text } from '#translations'; export const value = text.not_a_message;`,
        id,
      ),
    ).rejects.toThrow(/not_a_message/);
    expect(
      await call(
        "transform",
        `import { text } from 'unconfigured-source'; export const value = text.hello;`,
        id,
      ),
    ).toBeNull();
  });

  it("discovers the public generated entry and allows an explicit relative entry", async () => {
    const f = await fixture();
    await f.write("generated/messages.js", `export * from './messages/hello.js';`);
    const id = path.join(f.root, "src/entry.js");
    const source = `import { m } from '#translations'; export const value = m.color_red;`;
    await expect(pluginHarness(f).call("transform", source, id)).rejects.toThrow(/color_red/);
    await f.write("generated/custom/catalog.js", `export * from '../messages/color_red.js';`);
    const { call } = pluginHarness(f, { messagesEntry: "custom/catalog.js" });
    expect((await call("transform", source, id)).code).toContain("messages/color_red.js");
  });

  it("includes shared workspace source roots while excluding neighbors and generated subrequests", async () => {
    const f = await fixture();
    const { call } = pluginHarness(f);
    const source = `import { m } from '#translations'; export const value = m.hello;`;
    for (const relative of ["src/read.ts", "packages/ui/src/shared.ts"]) {
      expect((await call("transform", source, path.join(f.root, relative)))?.code).toContain(
        "messages/hello.js",
      );
    }
    for (const relative of [
      "src-other/read.ts",
      "packages/ui/src-other/read.ts",
      "generated/read.ts",
      "src/read.ts?raw",
    ]) {
      expect(await call("transform", source, path.join(f.root, relative))).toBeNull();
    }
  });

  it("never transforms generated Paraglide output inside a source root", async () => {
    const f = await fixture();
    const { call } = pluginHarness(f, { sourceRoots: ["."] });
    const source = `import { m } from '#translations'; export const value = m.hello;`;
    expect((await call("transform", source, path.join(f.root, "src/read.ts")))?.code).toContain(
      "messages/hello.js",
    );
    expect(await call("transform", source, path.join(f.outdir, "read.js"))).toBeNull();
  });

  it("waits for preceding asynchronous Paraglide generation on a clean build", async () => {
    const f = await fixture();
    await rm(path.join(f.outdir, "messages"), { recursive: true });
    const entry = await f.write(
      "src/entry.js",
      `import { m } from '#translations'; export const value = m.hello;`,
    );
    const chunks = await bundle(f, entry, [
      {
        name: "asynchronous-paraglide-fixture",
        enforce: "pre",
        async buildStart() {
          await new Promise((resolve) => setTimeout(resolve, 10));
          await f.writeMessages();
        },
      },
    ]);
    expect((await importBundle(chunks.find((chunk) => chunk.isEntry)!.code)).value).toBe("안녕");
  }, 120_000);

  it("discards added and deleted exports on build-watch updates, including an empty catalog", async () => {
    const f = await fixture();
    const { call } = pluginHarness(f, { missingKey: "undefined" });
    const id = path.join(f.root, "src/reader.js");
    const source = `import { m } from '#translations'; export const value = m.new_key ?? 'fallback';`;
    expect((await call("transform", source, id)).code).not.toContain("new_key.js");
    f.files["new_key.js"] = `export const new_key = () => 'New';`;
    await f.writeMessages();
    call("watchChange", f.indexFile, { event: "update" });
    expect((await call("transform", source, id)).code).toContain("new_key.js");
    await f.write("generated/messages/_index.js", "");
    call("watchChange", f.indexFile, { event: "update" });
    expect((await call("transform", source, id)).code).not.toContain("new_key.js");
  });

  it("coalesces staggered generation and invalidates importers and groups after complete output", async () => {
    const f = await fixture();
    const { call } = pluginHarness(f);
    const id = path.join(f.root, "src/reader.js");
    const virtualId = call("resolveId", "virtual:paraglide-sugar/messages/color_");
    const reader = { id };
    const group = { id: virtualId };
    const original = { id: path.join(f.outdir, "messages/color_red.js") };
    const nodes = new Map([
      [id, reader],
      [virtualId, group],
    ]);
    const watcher = Object.assign(new EventEmitter(), { add: vi.fn() });
    const invalidateModule = vi.fn();
    const send = vi.fn();
    const httpServer = new EventEmitter();
    const names = ["client", "ssr", "worker"];
    const environments = Object.fromEntries(
      names.map((name) => [
        name,
        {
          moduleGraph: {
            getModuleById: (key: string) => nodes.get(key),
            invalidateModule: (node: unknown) => invalidateModule(name, node),
          },
          hot: { send: (payload: unknown) => send(name, payload) },
        },
      ]),
    );
    call("configureServer", {
      watcher,
      httpServer,
      ws: { send: (payload: unknown) => send("ws", payload) },
      environments,
    });
    await call("transform", `import { m } from '#translations'; export const value = m.hello;`, id);
    await call("load", virtualId);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    f.files["color_green.js"] = `export const color_green = () => 'Green';`;
    await f.write(
      "generated/messages/_index.js",
      Object.keys(f.files)
        .map((filename) => `export * from './${filename}';`)
        .join("\n"),
    );
    expect(call("handleHotUpdate", { file: f.indexFile, modules: [original] })).toEqual([]);
    const pending = call(
      "transform",
      `import { m } from '#translations'; export const value = m.color_green;`,
      id,
    );
    let completed = false;
    void pending.then(() => {
      completed = true;
    });
    await vi.advanceTimersByTimeAsync(110);
    expect(completed).toBe(false);
    expect(send).not.toHaveBeenCalled();
    await f.write("generated/messages/color_green.js", "");
    watcher.emit("add", path.join(f.outdir, "messages/color_green.js"));
    await vi.advanceTimersByTimeAsync(110);
    expect(completed).toBe(false);
    expect(send).not.toHaveBeenCalled();
    await f.write("generated/messages/color_green.js", "export const color_green =");
    call("handleHotUpdate", {
      file: path.join(f.outdir, "messages/color_green.js"),
      modules: [],
    });
    await vi.advanceTimersByTimeAsync(110);
    expect(completed).toBe(false);
    expect(send).not.toHaveBeenCalled();
    await f.write("generated/messages/color_green.js", f.files["color_green.js"]);
    call("handleHotUpdate", {
      file: path.join(f.outdir, "messages/color_green.js"),
      modules: [],
    });
    call("handleHotUpdate", { file: f.indexFile, modules: [] });
    await vi.advanceTimersByTimeAsync(110);
    expect((await pending).code).toContain("color_green.js");
    expect(send.mock.calls).toEqual(
      names.map((name) => [name, { type: "full-reload", path: "*" }]),
    );
    for (const name of names) {
      expect(invalidateModule).toHaveBeenCalledWith(name, reader);
      expect(invalidateModule).toHaveBeenCalledWith(name, group);
    }
    expect(await call("load", virtualId)).toContain("color_green");
    expect(
      call("handleHotUpdate", { file: path.join(f.root, "src/unrelated.js"), modules: [] }),
    ).toBeUndefined();

    delete f.files["color_green.js"];
    await f.writeMessages();
    await rm(path.join(f.outdir, "messages/color_green.js"));
    watcher.emit("unlink", path.join(f.outdir, "messages/color_green.js"));
    await vi.advanceTimersByTimeAsync(110);
    expect(await call("load", virtualId)).not.toContain("color_green");
    expect(send).toHaveBeenCalledTimes(names.length * 2);
    httpServer.emit("close");
    expect(watcher.listenerCount("add")).toBe(0);
    expect(watcher.listenerCount("unlink")).toBe(0);
  });
});

describe("bundled static messages", () => {
  it("bounds virtual lookups to their prefix and preserves undefined for absent and prototype keys", async () => {
    const f = await fixture();
    const entry = await f.write(
      "src/groups.js",
      `
			import { messages } from 'virtual:paraglide-sugar/messages/color_';
			export const values = [messages.color_red(), messages.color_blue()];
			export const keys = Object.keys(messages).sort();
			export const missing = messages.color_absent?.() ?? 'fallback';
			export const prototypeKey = messages.toString?.() ?? 'prototype fallback';
		`,
    );
    const chunks = await bundle(f, entry);
    const code = chunks.map((chunk) => chunk.code).join("\n");
    expect(code).not.toContain("UNUSED_TRANSLATION_SENTINEL");
    expect(code).not.toContain("LAZY_TRANSLATION_SENTINEL");
    const exports = await importBundle(chunks.find((chunk) => chunk.isEntry)!.code);
    expect(exports.values).toEqual(["Red", "Blue"]);
    expect(exports.keys).toEqual(["color_blue", "color_red"]);
    expect(exports.missing).toBe("fallback");
    expect(exports.prototypeKey).toBe("prototype fallback");
  }, 120_000);

  it("tree shakes unused messages and keeps a lazy route translation outside the initial closure", async () => {
    const f = await fixture();
    await f.write(
      "src/lazy.js",
      `import { m } from '#translations'; export const label = m.lazy_only;`,
    );
    const entry = await f.write(
      "src/entry.js",
      `import { m } from '#translations'; export const label = m.hello; export const lazy = () => import('./lazy.js');`,
    );
    const chunks = await bundle(f, entry);
    const allCode = chunks.map((chunk) => chunk.code).join("\n");
    expect(allCode).not.toContain("UNUSED_TRANSLATION_SENTINEL");
    expect(allCode).toContain("LAZY_TRANSLATION_SENTINEL");
    expect(allCode).not.toContain("Runtime catalog access");
    const byFilename = new Map(chunks.map((chunk) => [chunk.fileName, chunk]));
    const visited = new Set<string>();
    function initialClosure(filename: string): string {
      if (visited.has(filename)) return "";
      visited.add(filename);
      const chunk = byFilename.get(filename);
      return chunk ? chunk.code + chunk.imports.map(initialClosure).join("\n") : "";
    }
    expect(initialClosure(chunks.find((chunk) => chunk.isEntry)!.fileName)).not.toContain(
      "LAZY_TRANSLATION_SENTINEL",
    );
  }, 120_000);

  it("renders shared Svelte components with independent request locales and escaped interpolation", async () => {
    const f = await fixture();
    await f.write(
      "packages/ui/src/Fixture.svelte",
      `<script>
			import { m } from '#translations';
			let { name } = $props();
		</script>
		<h1>{m.hello}</h1><p>{m.welcome._({ name })}</p><small>{m.missing ?? 'fallback'}</small><footer>{m['footer.terms']}</footer>`,
    );
    const entry = await f.write(
      "src/ssr.js",
      `
			import Fixture from '../packages/ui/src/Fixture.svelte';
			import { render } from 'svelte/server';
			import { withLocale } from '../generated/runtime.js';
			export const request = (locale, name) => withLocale(locale, async () => {
				await new Promise((resolve) => setTimeout(resolve, locale === 'ko' ? 2 : 1));
				return render(Fixture, { props: { name } }).body;
			});
		`,
    );
    const chunks = await bundle(f, entry, [], { missingKey: "undefined" });
    const exports = await importBundle(chunks.find((chunk) => chunk.isEntry)!.code);
    const [korean, english] = await Promise.all([
      exports.request("ko", "<Ada>"),
      exports.request("en", "Grace"),
    ]);
    expect(korean).toContain("<h1>안녕</h1>");
    expect(korean).toMatch(/ko:&lt;Ada(?:>|&gt;)/);
    expect(korean).not.toContain("<Ada>");
    expect(english).toContain("<h1>Hello</h1>");
    expect(english).toContain("en:Grace");
    expect(korean).toContain("<small>fallback</small>");
    expect(korean).toContain("<footer>Terms</footer>");
  }, 120_000);
});

describe("actual Paraglide compiler output", () => {
  it("retains locale changes, parameter types, original functions, and exact generated key names", async () => {
    const f = await fixture();
    await rm(f.outdir, { recursive: true });
    const generated = await compileCatalog();
    for (const [filename, contents] of Object.entries(generated)) {
      await f.write(`generated/${filename}`, contents);
    }
    const manifest = readMessageManifest(path.join(f.outdir, "messages.js"));
    expect(manifest.has("footer.terms")).toBe(true);
    expect(manifest.has("status_MixedCase")).toBe(true);
    expect(manifest.has("footer_terms")).toBe(false);
    await f.write(
      "src/Fixture.svelte",
      `<script>
			import { m } from '#translations';
			let { name } = $props();
		</script><h1>{m.hello}</h1><p>{m.welcome._({ name })}</p><footer>{m['footer.terms']}</footer>`,
    );
    const entry = await f.write(
      "src/actual.js",
      `
			import { m } from '#translations';
			import { hello, welcome } from '../generated/messages.js';
			import { setLocale } from '../generated/runtime.js';
			import { messages } from 'virtual:paraglide-sugar/messages/color_';
			import { render } from 'svelte/server';
			import Fixture from './Fixture.svelte';
			export const originalFunctions = m.hello._ === hello && m.welcome._ === welcome;
			export function read(locale, name) {
				setLocale(locale, { reload: false });
				return [m.hello, m.welcome._({ name }), m['footer.terms'], m.status_MixedCase,
					messages.color_red(), render(Fixture, { props: { name } }).body];
			}
		`,
    );
    const chunks = await bundle(f, entry);
    expect(chunks.map((chunk) => chunk.code).join("\n")).not.toContain(
      "UNUSED_TRANSLATION_SENTINEL",
    );
    const exports = await importBundle(chunks.find((chunk) => chunk.isEntry)!.code);
    expect(exports.originalFunctions).toBe(true);
    expect(exports.read("en", "Ada").slice(0, 5)).toEqual([
      "Hello",
      "Welcome, Ada",
      "Terms",
      "Mixed case",
      "Red",
    ]);
    const korean = exports.read("ko", "<Grace>");
    expect(korean.slice(0, 5)).toEqual(["안녕", "환영합니다, <Grace>", "약관", "대소문자", "빨강"]);
    expect(korean[5]).toContain("<h1>안녕</h1>");
    expect(korean[5]).toContain("&lt;Grace");
    expect(exports.read("en", "Ada")[0]).toBe("Hello");
  }, 120_000);
});
