import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { SourceMapConsumer } from "source-map-js";
import { compile } from "svelte/compiler";
import { render } from "svelte/server";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import { readMessageManifest } from "../src/manifest.js";
import * as runtime from "../src/runtime.js";
import {
  findImportUses,
  mayImportMarker,
  transformMessages,
  type TransformOptions,
} from "../src/transform.js";

const options: TransformOptions = { importSource: "#messages" };

const messages = new Map([
  ["hello", { source: "/catalog/messages/hello.js", exportName: "hello" }],
  ["welcome", { source: "/catalog/messages/welcome.js", exportName: "welcome" }],
  ["broken", { source: "/catalog/messages/broken.js", exportName: "broken" }],
  ["footer.terms", { source: "/catalog/messages/footer.terms.js", exportName: "footer.terms" }],
]);

function transform(
  code: string,
  filename = "/workspace/app/src/fixture.ts",
  overrides: Partial<TransformOptions> = {},
) {
  const result = transformMessages(code, filename, messages, { ...options, ...overrides });
  expect(result).not.toBeNull();
  return result!;
}

function execute(code: string, locale = { value: "ko" }) {
  const output = ts.transpileModule(code, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const modules: Record<string, unknown> = {
    "svelte/internal/server": createRequire(import.meta.url)("svelte/internal/server"),
    "vite-plugin-paraglide-sugar/runtime": runtime,
    "/catalog/messages/hello.js": { hello: () => (locale.value === "ko" ? "안녕" : "Hello") },
    "/catalog/messages/welcome.js": {
      welcome: (inputs: { name: string }, options?: { locale: string }) =>
        `${options?.locale ?? locale.value}:${inputs.name}`,
    },
    "/catalog/messages/broken.js": {
      broken: () => {
        throw new Error("broken translation");
      },
    },
    "/catalog/messages/footer.terms.js": { "footer.terms": () => "Terms" },
    "#messages": { getLocale: () => locale.value },
  };
  const exports: Record<string, any> = {};
  const require = (id: string) => {
    if (!(id in modules)) throw new Error(`Unexpected runtime dependency: ${id}`);
    return modules[id];
  };
  new Function("require", "exports", output)(require, exports);
  return { exports, output };
}

function importedBindings(code: string) {
  const source = ts.createSourceFile("fixture.ts", code, ts.ScriptTarget.Latest, true);
  return source.statements.flatMap((statement) => {
    if (!ts.isImportDeclaration(statement)) return [];
    const named = statement.importClause?.namedBindings;
    return named && ts.isNamedImports(named)
      ? named.elements.map((specifier) => specifier.name.text)
      : [];
  });
}

describe("message syntax transformation", () => {
  it("resolves translations at execution time and removes the runtime catalog import", () => {
    const result = transform(`import { m } from '#messages'; export const read = () => m.hello;`);
    const locale = { value: "ko" };
    const { exports, output } = execute(result.code, locale);
    expect(exports.read()).toBe("안녕");
    locale.value = "en";
    expect(exports.read()).toBe("Hello");
    expect(output).not.toContain("#messages");
    expect(result.code).not.toContain("/catalog/messages/welcome.js");
  });

  it("passes inputs, explicit locale options, and nested message expressions to interpolation", () => {
    const result = transform(`
			import { m } from '#messages';
			export const read = () => m.welcome._({ name: m.hello }, { locale: 'ja' });
			export const formatter = m.welcome._;
		`);
    const { exports } = execute(result.code);
    expect(exports.read()).toBe("ja:안녕");
    expect(exports.formatter({ name: "Ada" }, { locale: "en" })).toBe("en:Ada");
  });

  it("imports explicit function access directly without a runtime wrapper", () => {
    const result = transform(`import { m } from '#messages'; export const fn = m.welcome._;`);
    expect(result.code).not.toContain("vite-plugin-paraglide-sugar/runtime");
    expect(execute(result.code).exports.fn({ name: "Ada" })).toBe("ko:Ada");
  });

  it("uses a configured import source and named export, including local aliases", () => {
    const result = transform(
      `
			import { labels as translations } from '@example/translations';
			export const read = () => translations.hello;
		`,
      undefined,
      { importSource: "@example/translations", exportName: "labels" },
    );
    expect(execute(result.code).exports.read()).toBe("안녕");
    expect(result.code).not.toContain("@example/translations");
  });

  it("supports string-named marker exports and escaped module specifiers", () => {
    const result = transform(
      `
			import { "message sugar" as translations } from '\\u0023messages';
			export const read = () => translations.hello;
		`,
      undefined,
      { exportName: "message sugar" },
    );
    expect(execute(result.code).exports.read()).toBe("안녕");
  });

  it("leaves the same export from another source and other exports from the configured source alone", () => {
    const code = `
			import { m } from '#messages';
			import { labels } from '@elsewhere/messages';
			export const read = () => [m.hello, labels.hello];
		`;
    expect(
      transformMessages(code, "/fixture.ts", messages, {
        importSource: "#messages",
        exportName: "labels",
      }),
    ).toBeNull();
  });

  it("reports unknown static keys at their source location by default", () => {
    const code = `import { m } from '#messages';\nexport const label = m.absent;`;
    expect(() => transformMessages(code, "/src/missing.ts", messages, options)).toThrow(
      '[paraglide-sugar] /src/missing.ts:2:22: Unknown message key "absent"',
    );
  });

  it.each([
    [
      `const { hello } = m;`,
      /Destructuring the message object is unsupported; read each message as m\.key\.$/,
    ],
    [
      `const all = Object.keys(m);`,
      /only be read with a static key, such as m\.key.*messages\/<prefix> group/,
    ],
    [
      `const read = (key: string) => m[key];`,
      /cannot be resolved statically\. Use a bounded virtual/,
    ],
    [`m.hello = "changed";`, /Message properties are read-only\.$/],
  ])("explains why %s is rejected and records its source offset", (statement, message) => {
    const code = `import { m } from '#messages';\n${statement}`;
    let error: { message: string; pos: number } | undefined;
    try {
      transformMessages(code, "/src/reject.ts", messages, options);
    } catch (caught) {
      error = caught as typeof error;
    }
    expect(error?.message).toMatch(message);
    expect(error?.pos).toBeGreaterThan(code.indexOf("\n"));
  });

  it("uses the configured export in namespace re-export and dynamic import diagnostics", () => {
    const configured = { importSource: "@example/translations", exportName: "labels" };
    expect(() =>
      transformMessages(
        `export { labels } from '@example/translations';`,
        "/src/export.ts",
        messages,
        configured,
      ),
    ).toThrow(/message object cannot be re-exported; import it from "@example\/translations"/);
    expect(() =>
      transformMessages(
        `const lazy = import('@example/translations');`,
        "/src/import.ts",
        messages,
        configured,
      ),
    ).toThrow('Dynamic imports of "@example/translations"');
    expect(
      transformMessages(
        `export { m } from '@example/translations';`,
        "/src/export.ts",
        messages,
        configured,
      ),
    ).toBeNull();
  });

  it("defers parameterized bare values and propagates translation exceptions", () => {
    const result = transform(`
			import { m } from '#messages';
			export const deferred = m.welcome;
			export const failed = () => m.broken._();
			export const bare = () => m.broken;
		`);
    const { exports } = execute(result.code);
    expect(exports.deferred._({ name: "Ada" })).toBe("ko:Ada");
    expect(() => exports.failed()).toThrow("broken translation");
    expect(() => exports.bare()).toThrow("broken translation");
  });

  it("preserves undefined and nullish fallbacks for missing static keys", () => {
    const result = transform(
      `
			import { m } from '#messages';
			export const missing = (m as any).missing;
			export const fallback = (m as any).missing?.() ?? 'Fallback';
			export const nestedFallback = (m as any)['absent']?._?.() ?? 'Nested';
		`,
      undefined,
      { missingKey: "undefined" },
    );
    const { exports, output } = execute(result.code);
    expect(exports.missing).toBeUndefined();
    expect(exports.fallback).toBe("Fallback");
    expect(exports.nestedFallback).toBe("Nested");
    expect(output).not.toContain("#messages");
    expect(result.missing.map(({ key }) => key)).toEqual(["missing", "missing", "absent"]);
    for (const entry of result.missing) {
      expect(result.map.sourcesContent![0].slice(entry.position)).toMatch(/^(?:\(m|m)/);
    }
  });

  it("preserves semicolonless statements when a missing key becomes undefined", () => {
    const result = transform(
      `import { m } from '#messages'
const events = []
events.push('before')
m.absent?.()
events.push('after')
export { events }`,
      undefined,
      { missingKey: "undefined" },
    );
    expect(execute(result.code).exports.events).toEqual(["before", "after"]);
  });

  it("keeps a statement boundary when removing an unused import", () => {
    const result = transform(`const values = [1]
import { m } from '#messages'
[2].forEach(value => values.push(value))
export { values }`);
    expect(execute(result.code).exports.values).toEqual([1, 2]);
    expect(result.code).not.toContain("#messages");
  });

  it("resolves aliased imports, static computed keys, and TypeScript wrappers", () => {
    const result = transform(`
			import { m as translations } from '#messages';
			export const values = [
				translations.hello,
				translations['hello'],
				translations[\`hello\`],
				translations['hello' as keyof typeof translations],
				(translations as Record<string, any>)!.hello,
				(translations satisfies object).hello,
				(translations as any)['welcome']['_']({ name: 'Ada' })
			];
		`);
    expect(execute(result.code).exports.values).toEqual([
      "안녕",
      "안녕",
      "안녕",
      "안녕",
      "안녕",
      "안녕",
      "ko:Ada",
    ]);
  });

  it("transforms runtime expressions inside TypeScript namespaces and enums", () => {
    const result = transform(`
			import { m } from '#messages';
			namespace Labels { export const title = m.hello; }
			enum Titles { hello = m.hello as any }
			export const values = [Labels.title, Titles.hello];
		`);
    expect(execute(result.code).exports.values).toEqual(["안녕", "안녕"]);
  });

  it("uses the actual string export name when a generated filename contains dots", () => {
    const result = transform(
      `import { m } from '#messages'; export const terms = m['footer.terms'];`,
    );
    expect(execute(result.code).exports.terms).toBe("Terms");
  });

  it("leaves strings, comments, regular expressions, and unrelated properties unchanged", () => {
    const result = transform(`
			import { m } from '#messages';
			// m.hello must remain a comment
			const object = { m: { hello: 'local' } };
			export const values = ['m.hello', \`m.hello\`, /m.hello/.source, object.m.hello, m.hello];
		`);
    expect(execute(result.code).exports.values).toEqual([
      "m.hello",
      "m.hello",
      "m.hello",
      "local",
      "안녕",
    ]);
    expect(result.code).toContain("// m.hello must remain a comment");
  });

  it("respects function, block, catch, and destructuring bindings that shadow the import", () => {
    const result = transform(`
			import { m } from '#messages';
			function fromArgument(m: { hello: string }) { return m.hello; }
			function fromBlock() { const m = { hello: 'block' }; return m.hello; }
			function fromCatch() { try { throw { hello: 'caught' }; } catch (m) { return (m as any).hello; } }
			const fromPattern = ({ m }: { m: { hello: string } }) => m.hello;
			export const values = [m.hello, fromArgument({ hello: 'argument' }), fromBlock(), fromCatch(), fromPattern({ m: { hello: 'pattern' } })];
		`);
    expect(execute(result.code).exports.values).toEqual([
      "안녕",
      "argument",
      "block",
      "caught",
      "pattern",
    ]);
  });

  it("keeps other imports and type-only uses without retaining the catalog at runtime", () => {
    const result = transform(`
			import { m, getLocale, type I18nFlags } from '#messages';
			type MessageKeys = keyof typeof m;
			export const read = (_key: MessageKeys, _flags: I18nFlags) => [m.hello, getLocale()];
		`);
    expect(result.code).toContain("keyof typeof m");
    expect(execute(result.code).exports.read("hello", {})).toEqual(["안녕", "ko"]);
    const onlyType = transform(`
			import { m } from '#messages';
			type Keys = keyof typeof m;
			export const read = (_key: Keys) => m.hello;
		`);
    expect(execute(onlyType.code).output).not.toContain("#messages");
  });

  it("does not turn type-only imports into runtime imports", () => {
    const code = `import type { m } from '#messages'; export type Keys = keyof typeof m;`;
    const result = transformMessages(code, "/workspace/app/src/types.ts", messages, options);
    const output = execute(result?.code ?? code).output;
    expect(output).not.toContain("#messages");
    expect(output).not.toContain("/catalog/");
  });

  it("avoids collisions with both generated message and helper identifiers", () => {
    const initial = transform(`import { m } from '#messages'; export const value = m.hello;`);
    const occupied = importedBindings(initial.code);
    expect(occupied.length).toBeGreaterThan(0);
    const declarations = occupied.map((name, index) => `const ${name} = ${index};`).join("\n");
    const result = transform(`
			import { m } from '#messages';
			${declarations}
			export const value = m.hello;
			export const locals = [${occupied.join(", ")}];
		`);
    const { exports } = execute(result.code);
    expect(exports.value).toBe("안녕");
    expect(exports.locals).toEqual(occupied.map((_, index) => index));
  });

  it.each([
    `import { m } from '#messages'; export const read = (key: string) => m[key];`,
    `import { m } from '#messages'; export const all = Object.keys(m);`,
    `import { m } from '#messages'; export const all = { ...m };`,
    `import { m } from '#messages'; export { m };`,
    `export { m } from '#messages';`,
    `export * from '#messages';`,
    `import * as i18n from '#messages'; export const value = i18n.m.hello;`,
    `import i18n from '#messages'; export const value = i18n.m.hello;`,
    `export const lazy = import('#messages');`,
    `export const lazy = import(\`#messages\`);`,
  ])("rejects runtime access that would require the whole catalog: %s", (code) => {
    expect(() =>
      transformMessages(code, "/workspace/app/src/dynamic.ts", messages, options),
    ).toThrow(/paraglide-sugar|static|dynamic/i);
  });

  it.each([
    `m.hello = 'changed';`,
    `m.hello += '!';`,
    `m.hello++;`,
    `delete m.hello;`,
    `m.welcome._ = () => 'changed';`,
    `({ value: m.hello } = { value: 'changed' });`,
    `for (m.hello of ['changed']) {}`,
  ])("rejects catalog writes instead of generating an invalid assignment: %s", (statement) => {
    expect(() =>
      transformMessages(
        `import { m } from '#messages'; ${statement}`,
        "/workspace/app/src/write.ts",
        messages,
        options,
      ),
    ).toThrow(/paraglide-sugar|read|assign|mutat/i);
  });

  it("preserves explicitly type-only exports without introducing runtime catalog access", () => {
    for (const code of [
      `import { m } from '#messages'; export { type m };`,
      `export { type m } from '#messages';`,
      `import type * as i18n from '#messages'; export type Keys = keyof typeof i18n.m;`,
    ]) {
      const result = transformMessages(code, "/workspace/app/src/types.ts", messages, options);
      expect(execute(result?.code ?? code).output).not.toContain("#messages");
    }
  });

  it("permits explicit reexports of runtime helpers without exposing the message catalog", () => {
    const code = `export { getLocale } from '#messages';`;
    const result = transformMessages(code, "/workspace/app/src/helpers.ts", messages, options);
    expect(execute(result?.code ?? code).exports.getLocale()).toBe("ko");
  });

  it("skips sources whose only backslashes are outside module specifiers", () => {
    for (const code of [
      String.raw`const pattern = /\d+/; const text = "a\nb"; Array.from("\t");`,
      String.raw`const label = "data from \"x\""; import("./a.js");`,
    ]) {
      expect(mayImportMarker(code, "#messages")).toBe(false);
      // Unparseable code proves that no parser ran.
      expect(
        transformMessages(`${code} not valid syntax`, "/src/a.ts", messages, options),
      ).toBeNull();
    }
    for (const code of [
      String.raw`import { m } from '\u0023messages';`,
      String.raw`export { m } from"\u0023messages";`,
      String.raw`const load = () => import ( ` + "`\\u0023messages`" + ` );`,
      String.raw`import { m } from /* note */ '\x23messages';`,
      String.raw`export * from // note` + "\n" + String.raw`'\x23messages';`,
      String.raw`const load = () => import /* a */ (/* @vite-ignore */ '\x23messages');`,
    ]) {
      expect(mayImportMarker(code, "#messages")).toBe(true);
    }
  });

  it("finds runtime reads and re-exports of imported bindings in compiled code", () => {
    const uses = findImportUses(`
      import { m, other } from "./named.js";
      import { m as kept } from "./unused.js";
      import * as ns from "./member.js";
      import * as escaped from "./escaped.js";
      import def, { m as local } from "./reexport.js";
      export * from "./star.js";
      export * as all from "./whole.js";
      export { m as text, other as more } from "./named-reexport.js";
      export { local as alias };
      export default def;
      export const read = () => [m.hello, ns.helper(), ns?.["m"], escaped[key], use(escaped)];
    `);
    const summary = Object.fromEntries(
      [...uses].map(([source, { reads, exports, star }]) => [
        source,
        { reads: reads === true ? true : [...reads], exports, star },
      ]),
    );
    expect(summary).toEqual({
      "./named.js": { reads: ["m"], exports: [], star: false },
      "./unused.js": { reads: [], exports: [], star: false },
      "./member.js": { reads: ["helper", "m"], exports: [], star: false },
      "./escaped.js": { reads: true, exports: [], star: false },
      "./reexport.js": {
        reads: [],
        exports: [
          ["default", "default"],
          ["m", "alias"],
        ],
        star: false,
      },
      "./star.js": { reads: [], exports: [], star: true },
      "./whole.js": { reads: true, exports: [], star: false },
      "./named-reexport.js": {
        reads: [],
        exports: [
          ["m", "text"],
          ["other", "more"],
        ],
        star: false,
      },
    });
  });

  it("keeps import attributes on the retained marker import", () => {
    for (const ending of [";", "", "\n"]) {
      const result = transform(
        `import { m, getLocale } from '#messages' with { type: "js" }${ending}\nexport const read = () => [m.hello, getLocale()];`,
      );
      expect(result.code).toContain(`import { getLocale } from "#messages" with { type: "js" };`);
    }
  });

  it("ignores a same-named import from an unrelated module", () => {
    const code = `import { m } from './different'; export const value = m.hello;`;
    expect(transformMessages(code, "/workspace/app/src/other.ts", messages, options)).toBeNull();
  });

  it("maps unchanged source positions and retains original content after import insertion", () => {
    const code = `import { m } from '#messages';\nexport const value = m.hello;\nexport const sentinel = 'position';\n`;
    const result = transform(code);
    expect(result.map).toBeTruthy();
    const map = new SourceMapConsumer(JSON.parse(JSON.stringify(result.map)));
    const generatedBefore = result.code.slice(0, result.code.indexOf("'position'"));
    const generatedLines = generatedBefore.split("\n");
    const position = map.originalPositionFor({
      line: generatedLines.length,
      column: generatedLines.at(-1)!.length,
    });
    expect(position.line).toBe(3);
    expect(position.column).toBe("export const sentinel = ".length);
    expect(map.sourceContentFor(position.source!)).toBe(code);
  });
});

describe("constant message aliases", () => {
  it("preserves semicolonless standalone alias reads and calls", () => {
    const result = transform(`import { m } from '#messages'
const alias = m
const events = []
events.push('before')
alias.hello._()
events.push('between')
alias.hello
events.push('after')
export { events }`);
    let reads = 0;
    const { exports } = execute(result.code, {
      get value() {
        reads++;
        return "ko";
      },
    });
    expect(exports.events).toEqual(["before", "between", "after"]);
    expect(reads).toBe(2);
  });

  it("keeps alias reads attached to their conditional and loop bodies", () => {
    const result = transform(`import { m } from '#messages'
const alias = m
export let count = 0
if (false) alias.hello._()
else count++
for (let i = 0; i < 2; i++) alias.hello._()
while (count < 2) alias.hello._(), count++
do alias.hello._(); while (false)
label: alias.hello._()`);
    let reads = 0;
    const { exports } = execute(result.code, {
      get value() {
        reads++;
        return "ko";
      },
    });
    expect(exports.count).toBe(2);
    expect(reads).toBe(5);
  });

  it("resolves static accesses through cast and nested const aliases with live locale values", () => {
    const result = transform(
      `
			import { m } from '#messages';
			const first = m as Record<string, any>;
			const second = (first satisfies object)!;
			export const read = () => {
				const nested = second as any;
				return [nested.hello, nested['welcome']._({ name: nested.hello }, { locale: 'ja' }), nested.absent ?? 'Fallback'];
			};
		`,
      undefined,
      { missingKey: "undefined" },
    );
    const locale = { value: "ko" };
    const { exports, output } = execute(result.code, locale);
    expect(exports.read()).toEqual(["안녕", "ja:안녕", "Fallback"]);
    locale.value = "en";
    expect(exports.read()).toEqual(["Hello", "ja:Hello", "Fallback"]);
    expect(output).not.toContain("#messages");
  });

  it("preserves lexical shadows and neighboring declarator side effects", () => {
    const result = transform(`
			import { m } from '#messages';
			const events: string[] = [];
			const before = events.push('before'), alias = m as any, after = events.push('after');
			const local = (alias: { hello: string }) => alias.hello;
			const block = () => { const alias = { hello: 'block' }; return alias.hello; };
			export const values = [alias.hello, local({ hello: 'argument' }), block(), before, after];
			export { events };
		`);
    const { exports } = execute(result.code);
    expect(exports.values).toEqual(["안녕", "argument", "block", 1, 2]);
    expect(exports.events).toEqual(["before", "after"]);
  });

  it("retains errors for aliases read before their declaration, including chained initializers", () => {
    const result = transform(`
			import { m } from '#messages';
			export function earlyMember() {
				return alias.hello;
				const alias = m;
			}
			export function earlyChain() {
				const second = first;
				const first = m;
				return second.hello;
			}
		`);
    const { exports } = execute(result.code);
    expect(() => exports.earlyMember()).toThrow(ReferenceError);
    expect(() => exports.earlyChain()).toThrow(ReferenceError);
  });

  it("preserves inferred and asserted alias types without a runtime catalog import", () => {
    const result = transform(`
			import { m } from '#messages';
			const inferred = m;
			const chained = inferred;
			const asserted = m as { hello: string };
			export type InferredKeys = keyof typeof chained;
			export type AssertedKeys = keyof typeof asserted;
			export const value = chained.hello;
		`);
    const fixture = "/alias-types.ts";
    const declarations = "/catalog-types.d.ts";
    const files = new Map([
      [fixture, result.code],
      [
        declarations,
        `declare module '#messages' { export const m: { hello: string; welcome: string }; }
				declare module 'vite-plugin-paraglide-sugar/runtime' { export function resolveMessage(fn: () => string): string; }
				declare module '*/hello.js' { export function hello(): string; }`,
      ],
    ]);
    const options = { noLib: true, noEmit: true, module: ts.ModuleKind.ESNext };
    const host = ts.createCompilerHost(options);
    host.getSourceFile = (filename) => {
      const source = files.get(filename);
      return source === undefined
        ? undefined
        : ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
    };
    host.fileExists = (filename) => files.has(filename);
    host.readFile = (filename) => files.get(filename);
    const program = ts.createProgram([fixture, declarations], options, host);
    const source = program.getSourceFile(fixture)!;
    expect(
      program.getSemanticDiagnostics(source).map((diagnostic) => diagnostic.messageText),
    ).toEqual([]);
    const checker = program.getTypeChecker();
    const types = Object.fromEntries(
      source.statements
        .filter(ts.isTypeAliasDeclaration)
        .map((declaration) => [
          declaration.name.text,
          checker.typeToString(checker.getTypeFromTypeNode(declaration.type)),
        ]),
    );
    expect(types).toEqual({ InferredKeys: '"hello" | "welcome"', AssertedKeys: '"hello"' });
    const { exports, output } = execute(result.code);
    expect(exports.value).toBe("안녕");
    expect(output).not.toContain("#messages");
  });

  it("keeps plain JavaScript aliases valid without requiring a TypeScript script", () => {
    const result = transform(
      `import { m } from '#messages'; const alias = m; export const value = alias.hello;`,
      "/workspace/app/src/alias.js",
    );
    expect(execute(result.code).exports.value).toBe("안녕");
    expect(() =>
      compile(`<script module>${result.code}</script>`, { generate: "server" }),
    ).not.toThrow();
  });

  it("resolves Svelte script aliases while keeping each and snippet parameters local", () => {
    const code = `<script lang="ts">
			import { m } from '#messages';
			const translations = m as any;
			const rows = [{ hello: 'local' }];
		</script>
		<p>{translations.hello} {translations.welcome._({ name: 'Ada' })}</p>
		{#each rows as translations (translations.hello)}<span>{translations.hello}</span>{/each}
		{#snippet local(translations: { hello: string })}<strong>{translations.hello}</strong>{/snippet}
		{@render local(rows[0])}`;
    const result = transform(code, "/workspace/app/src/Aliases.svelte");
    expect(result.code).not.toContain("#messages");
    expect(result.code).toContain(
      "{#each rows as translations (translations.hello)}<span>{translations.hello}</span>{/each}",
    );
    expect(result.code).toContain(
      "{#snippet local(translations: { hello: string })}<strong>{translations.hello}</strong>{/snippet}",
    );
    for (const generate of ["server", "client"] as const) {
      expect(() => compile(result.code, { filename: "Aliases.svelte", generate })).not.toThrow();
    }
  });

  it.each([
    `let alias = m; export const value = alias.hello;`,
    `var alias = m; export const value = alias.hello;`,
    `const { hello } = m;`,
    `const alias = m; alias = {};`,
    `const alias = m; alias.hello = 'changed';`,
    `const alias = m; alias.welcome._ = () => 'changed';`,
    `const alias = m; export const read = (key: string) => alias[key];`,
    `const alias = m; export const keys = Object.keys(alias);`,
    `const alias = m; consume(alias);`,
    `const alias = m; export const read = () => alias;`,
    `export const alias = m;`,
    `const alias = m; export { alias };`,
    `const first = m; const second = first; export const all = { ...second };`,
  ])("rejects mutable or escaping namespace aliases: %s", (statement) => {
    expect(() =>
      transformMessages(
        `import { m } from '#messages'; ${statement}`,
        "/workspace/app/src/alias.ts",
        messages,
        options,
      ),
    ).toThrow(/paraglide-sugar|static|dynamic|read|assign|mutat/i);
  });
});

describe("Svelte source transformation", () => {
  it("renders chained template const aliases while preserving nested shadows and branches", () => {
    const code = `<script lang="ts">
      import { m } from '#messages';
      const scriptAlias = m;
      let { name = 'Ada', show = true } = $props();
      const rows = [{ hello: 'each-local' }];
    </script>
    {#if show}
      {@const labels = m}
      {@const chained = labels}
      {@const fromScript = scriptAlias}
      <p>{labels.hello}|{chained.welcome._({ name }, { locale: 'en' })}|{fromScript.hello}</p>
      {#each rows as labels}<span>{labels.hello}</span>{/each}
      {#if true}
        {@const chained = { hello: 'const-local' }}
        <strong>{chained.hello}</strong>
      {/if}
      <em>{chained.hello}</em>
    {:else}
      <small>{m.hello}</small>
    {/if}`;
    const result = transform(code, "/workspace/app/src/ConstAliases.svelte");
    expect(result.code).not.toContain("#messages");
    expect(() =>
      compile(result.code, { filename: "ConstAliases.svelte", generate: "client" }),
    ).not.toThrow();
    const compiled = compile(result.code, {
      filename: "ConstAliases.svelte",
      generate: "server",
    });
    const Component = execute(compiled.js.code).exports.default;
    const body = render(Component, { props: { name: "Grace", show: true } }).body;
    expect(body).toContain("<p>안녕|en:Grace|안녕</p>");
    expect(body).toContain("<span>each-local</span>");
    expect(body).toContain("<strong>const-local</strong>");
    expect(body).toContain("<em>안녕</em>");
    const otherBranch = render(Component, { props: { show: false } }).body;
    expect(otherBranch).toContain("<small>안녕</small>");
    expect(otherBranch).not.toContain("<p>");
  });

  it.each([
    `<button onclick={() => { labels.hello = 'changed'; }}>Change</button>`,
    `<button onclick={() => { labels = {}; }}>Change</button>`,
    `<p>{Object.keys(labels)}</p>`,
    `{@const chained = labels}<p>{consume(chained)}</p>`,
  ])("rejects mutation and namespace escapes through template const aliases: %s", (usage) => {
    const code = `<script>import { m } from '#messages';</script>
      {#if true}{@const labels = m}${usage}{/if}`;
    expect(() =>
      transformMessages(code, "/workspace/app/src/ConstEscape.svelte", messages, options),
    ).toThrow(/read-only|can only be read with a static key/);
  });

  it("supports legacy reactive declarations and their lexical scopes", () => {
    const code = `<script lang="ts">
      import { m } from '#messages';
      export let name = 'Ada';
      let local = '';
      $: title = m.hello;
      $: label = m.welcome._({ name });
      $: { const m = { hello: name }; local = m.hello; }
    </script>
    <h1>{title}</h1><p>{label}</p><small>{local}</small>`;
    const result = transform(code, "/workspace/app/src/Legacy.svelte");
    expect(result.code).not.toContain("#messages");
    expect(result.code).toContain("$: { const m = { hello: name }; local = m.hello; }");
    for (const generate of ["server", "client"] as const) {
      const compiled = compile(result.code, { filename: "Legacy.svelte", generate });
      expect(compiled.metadata.runes).toBe(false);
      expect(compiled.js.code).toContain("/catalog/messages/hello.js");
      expect(compiled.js.code).toContain("/catalog/messages/welcome.js");
    }
  });

  it("compiles transformed script and template references for both server and client", () => {
    const code = `<script lang="ts">
			import { m as t } from '#messages';
			let { name = 'Ada' }: { name?: string } = $props();
			const read = () => t.hello;
		</script>
		<p title={t.hello}>{read()} {t.welcome._({ name }, { locale: 'en' })}</p>`;
    const result = transform(code, "/workspace/packages/ui/Fixture.svelte");
    expect(result.code).not.toContain("from '#messages'");
    for (const generate of ["server", "client"] as const) {
      const compiled = compile(result.code, { filename: "Fixture.svelte", generate });
      expect(compiled.js.code).toContain("/catalog/messages/hello.js");
      expect(compiled.js.code).toContain("/catalog/messages/welcome.js");
    }
  });

  it("resolves template bindings independently for each blocks, snippets, and const tags", () => {
    const code = `<script>
			import { m } from '#messages';
			const rows = [{ hello: 'local' }];
		</script>
		<p>{m.hello}</p>
		{#each rows as m (m.hello)}<span>{m.hello}</span>{/each}
		{#snippet local(m)}<strong>{m.hello}</strong>{/snippet}
		{@render local(rows[0])}
		{#if true}{@const m = rows[0]}<em>{m.hello}</em>{/if}
		<p>{m.hello}</p>`;
    const result = transform(code, "/workspace/app/src/Scopes.svelte");
    expect(result.code).toContain("{#each rows as m (m.hello)}<span>{m.hello}</span>{/each}");
    expect(result.code).toContain("{#snippet local(m)}<strong>{m.hello}</strong>{/snippet}");
    expect(result.code).toContain("{@const m = rows[0]}<em>{m.hello}</em>");
    for (const generate of ["server", "client"] as const) {
      expect(() => compile(result.code, { filename: "Scopes.svelte", generate })).not.toThrow();
    }
  });

  it("keeps module and instance script imports in valid scopes", () => {
    const code = `<script module>
			import { m as moduleMessages } from '#messages';
			export const moduleRead = () => moduleMessages.hello;
		</script>
		<script>
			import { m } from '#messages';
		</script>
		<p>{m.hello} {moduleRead()}</p>`;
    const result = transform(code, "/workspace/app/src/Module.svelte");
    for (const generate of ["server", "client"] as const) {
      expect(() => compile(result.code, { filename: "Module.svelte", generate })).not.toThrow();
    }
    expect(result.code).not.toContain("#messages");
  });
});

describe("generated message manifests", () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const directory of directories.splice(0))
      fs.rmSync(directory, { recursive: true, force: true });
  });
  function fixture(files: Record<string, string>) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "paraglide-sugar-manifest-"));
    directories.push(directory);
    for (const [filename, source] of Object.entries(files)) {
      const fullPath = path.join(directory, filename);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, source);
    }
    return directory;
  }

  it("resolves the public barrel into real leaf exports without exposing the m namespace", () => {
    const directory = fixture({
      "messages.js": `export * from './messages/_index.js'; export * as m from './messages/_index.js';`,
      "messages/_index.js": `export { hello as greeting } from './unrelated-filename.js'; export * from './quoted.js';`,
      "messages/unrelated-filename.js": `export const hello = () => 'Hello';`,
      "messages/quoted.js": `const terms = () => 'Terms'; export { terms as 'footer.terms' };`,
    });
    const manifest = readMessageManifest(path.join(directory, "messages.js"));
    expect([...manifest.keys()]).toEqual(["greeting", "footer.terms"]);
    expect(manifest.get("greeting")).toEqual({
      source: path.join(directory, "messages/unrelated-filename.js").split(path.sep).join("/"),
      exportName: "hello",
    });
    expect(manifest.get("footer.terms")?.exportName).toBe("footer.terms");
  });

  it("unwraps a namespace-only public barrel into message functions", () => {
    const directory = fixture({
      "messages.js": `export * as m from './messages/_index.js';`,
      "messages/_index.js": `export * from './hello.js';`,
      "messages/hello.js": `export const hello = () => 'Hello';`,
    });
    expect([...readMessageManifest(path.join(directory, "messages.js")).keys()]).toEqual(["hello"]);
  });

  it.each(["messages.js", "messages/_index.js"])(
    "rejects locale-module output even through a public barrel: %s",
    (entry) => {
      const directory = fixture({
        "messages.js": `export * from './messages/_index.js'; export * as m from './messages/_index.js';`,
        "messages/_index.js": `export const hello = () => 'Hello';`,
      });
      expect(() => readMessageManifest(path.join(directory, entry))).toThrow(
        "outputStructure: 'message-modules'",
      );
    },
  );

  it.each([
    { source: `export const broken = ;`, error: /Invalid generated module/ },
    { source: `export * from './missing.js';`, error: /Cannot read/ },
    { source: `export * from 'other-package';`, error: /must be local modules/ },
    { source: `export * from './messages.js';`, error: /Circular message re-export/ },
    { source: `export * from './empty.js';`, error: /has no exports yet/ },
    { source: `export { absent } from './hello.js';`, error: /Missing export "absent"/ },
  ])("rejects incomplete or unsupported generated modules: $source", ({ source, error }) => {
    const directory = fixture({
      "messages.js": source,
      "empty.js": "",
      "hello.js": `export const hello = () => 'Hello';`,
    });
    expect(() => readMessageManifest(path.join(directory, "messages.js"))).toThrow(error);
  });

  it("allows a completely empty generated catalog", () => {
    const directory = fixture({
      "messages.js": `export * from './messages/_index.js'; export * as m from './messages/_index.js';`,
      "messages/_index.js": "",
    });
    expect(readMessageManifest(path.join(directory, "messages.js")).size).toBe(0);
  });
});
