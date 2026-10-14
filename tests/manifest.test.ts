import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readMessageManifest } from "../src/manifest.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture(files: Record<string, string>) {
  const directory = await mkdtemp(path.join(tmpdir(), "paraglide-sugar-exports-"));
  directories.push(directory);
  for (const [name, contents] of Object.entries({
    "package.json": '{"type":"module"}',
    ...files,
  })) {
    const filename = path.join(directory, name);
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, contents);
  }
  return path.join(directory, "messages.js");
}

function expectNativeExports(entry: string, namespace?: string) {
  const manifest = readMessageManifest(entry);
  // A separate Node process evaluates native ESM, without the test runner's
  // module transforms deciding how star exports and binding aliases behave.
  const result = JSON.parse(
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
          import { pathToFileURL } from 'node:url';
          const [entry, entries, namespace] = process.argv.slice(1);
          const root = await import(pathToFileURL(entry).href);
          const catalog = namespace ? root[namespace] : root;
          const expected = Object.fromEntries(Object.entries(catalog)
            .filter(([, value]) => typeof value === 'function')
            .map(([key, value]) => [key, value()]));
          const actual = Object.create(null);
          for (const [key, { source, exportName }] of JSON.parse(entries)) {
            const module = await import(pathToFileURL(source).href);
            actual[key] = module[exportName]();
          }
          process.stdout.write(JSON.stringify({ expected, actual }));
        `,
        entry,
        JSON.stringify([...manifest]),
        namespace ?? "",
      ],
      { encoding: "utf8" },
    ),
  );
  expect(result.actual).toEqual(result.expected);
  return manifest;
}

function expectNativeImportFailure(entry: string, key: string) {
  const error = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
        import { pathToFileURL } from 'node:url';
        const [entry, key] = process.argv.slice(1);
        const importer = 'import { ' + JSON.stringify(key) + ' as message } from '
          + JSON.stringify(pathToFileURL(entry).href) + ';';
        try {
          await import('data:text/javascript;base64,' + Buffer.from(importer).toString('base64'));
        } catch (error) {
          process.stdout.write(error.message);
        }
      `,
      entry,
      key,
    ],
    { encoding: "utf8" },
  );
  expect(error).toMatch(/conflicting star exports/);
}

describe("message manifest ESM export resolution", () => {
  it.each(["before", "after"])("prefers an explicit re-export %s a star export", async (order) => {
    const explicit = "export { hello } from './messages/override.js';";
    const star = "export * from './messages/original.js';";
    const entry = await fixture({
      "messages.js": order === "before" ? `${explicit}\n${star}` : `${star}\n${explicit}`,
      "messages/original.js": "export const hello = () => 'Original';",
      "messages/override.js": "export const hello = () => 'Override';",
    });
    expectNativeExports(entry);
  });

  it.each(["before", "after"])(
    "prefers an exported declaration %s a star export",
    async (order) => {
      const explicit = "export const hello = () => 'Declared';";
      const star = "export * from './original.js';";
      const entry = await fixture({
        "messages.js": "export * from './messages/declared.js';",
        "messages/declared.js":
          order === "before" ? `${explicit}\n${star}` : `${star}\n${explicit}`,
        "messages/original.js": "export const hello = () => 'Original';",
      });
      expectNativeExports(entry);
    },
  );

  it("omits ambiguous star exports while retaining unambiguous messages", async () => {
    const entry = await fixture({
      "messages.js": "export * from './messages/first.js'; export * from './messages/second.js';",
      "messages/first.js": "export const hello = () => 'First'; export const first = () => 'One';",
      "messages/second.js":
        "export const hello = () => 'Second'; export const second = () => 'Two';",
    });
    expect([...expectNativeExports(entry).keys()].sort()).toEqual(["first", "second"]);
  });

  it("propagates nested star ambiguities instead of reviving a conflicting name", async () => {
    const entry = await fixture({
      "messages.js": "export * from './nested.js'; export * from './messages/third.js';",
      "nested.js": "export * from './messages/first.js'; export * from './messages/second.js';",
      "messages/first.js": "export const hello = () => 'First';",
      "messages/second.js": "export const hello = () => 'Second';",
      "messages/third.js":
        "export const hello = () => 'Third'; export const unique = () => 'Unique';",
    });
    expectNativeImportFailure(entry, "hello");
    expect([...readMessageManifest(entry).keys()]).toEqual(["unique"]);
  });

  it.each(["before", "after"])(
    "resolves a star conflict with an explicit export %s it",
    async (order) => {
      const explicit = "export { hello } from './messages/chosen.js';";
      const stars = "export * from './messages/first.js'; export * from './messages/second.js';";
      const entry = await fixture({
        "messages.js": order === "before" ? `${explicit}\n${stars}` : `${stars}\n${explicit}`,
        "messages/first.js": "export const hello = () => 'First';",
        "messages/second.js": "export const hello = () => 'Second';",
        "messages/chosen.js": "export const hello = () => 'Chosen';",
      });
      expectNativeExports(entry);
    },
  );

  it("keeps diamond re-exports of the same binding even through different local aliases", async () => {
    const entry = await fixture({
      "messages.js": "export * from './left.js'; export * from './right.js';",
      "left.js": "export { first as hello } from './messages/greeting.js';",
      "right.js": "export { second as hello } from './messages/greeting.js';",
      "messages/greeting.js":
        "const greeting = () => 'Hello'; export { greeting as first, greeting as second };",
    });
    expect([...expectNativeExports(entry).keys()]).toEqual(["hello"]);
  });

  it("distinguishes different local bindings even when they hold the same function", async () => {
    const entry = await fixture({
      "messages.js": "export * from './left.js'; export * from './right.js';",
      "left.js": "export { first as hello } from './messages/greeting.js';",
      "right.js": "export { second as hello } from './messages/greeting.js';",
      "messages/greeting.js":
        "const first = () => 'Hello'; const second = first; export { first, second };",
    });
    expect(expectNativeExports(entry).size).toBe(0);
  });

  it("rejects explicit re-exports of ambiguous names", async () => {
    const entry = await fixture({
      "messages.js": "export { hello } from './ambiguous.js';",
      "ambiguous.js": "export * from './messages/first.js'; export * from './messages/second.js';",
      "messages/first.js": "export const hello = () => 'First';",
      "messages/second.js": "export const hello = () => 'Second';",
    });
    expectNativeImportFailure(entry, "hello");
    expect(() => readMessageManifest(entry)).toThrow(/Missing export "hello"/);
  });

  it("preserves Paraglide namespace-only entries and excludes default exports from stars", async () => {
    const entry = await fixture({
      "messages.js": "export * as m from './messages/_index.js';",
      "messages/_index.js": "export * from './hello.js';",
      "messages/hello.js":
        "const hello = () => 'Hello'; const other = () => 'Default'; export { hello, other as default };",
    });
    expect([...expectNativeExports(entry, "m").keys()]).toEqual(["hello"]);
  });

  it("gives an explicit namespace precedence over a star-exported message with its name", async () => {
    const entry = await fixture({
      "messages.js":
        "export * as m from './messages/_index.js'; export * from './messages/_index.js';",
      "messages/_index.js": "export * from './hello.js';",
      "messages/hello.js": "export const hello = () => 'Hello'; export const m = () => 'Shadowed';",
    });
    expect([...expectNativeExports(entry).keys()]).toEqual(["hello"]);
  });

  it("still rejects referenced modules that have not been written yet", async () => {
    const entry = await fixture({
      "messages.js": "export * from './messages/hello.js';",
      "messages/hello.js": "// Generation is in progress.",
    });
    expect(() => readMessageManifest(entry)).toThrow(/has no exports yet/);
  });
});
