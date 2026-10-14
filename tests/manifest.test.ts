import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readMessageManifest, type ManifestCache } from "../src/manifest.js";

const directories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
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

  it("re-parses only changed modules and forgets unreferenced ones with a cache", async () => {
    const entry = await fixture({
      "messages.js": "export * from './messages/hello.js'; export * from './messages/bye.js';",
      "messages/hello.js": "export const hello = () => 'Hello';",
      "messages/bye.js": "export const bye = () => 'Bye';",
    });
    // Modules older than the filesystem timestamp step are trusted by their stat alone.
    const past = new Date(Date.now() - 60_000);
    for (const name of ["messages.js", "messages/hello.js", "messages/bye.js"])
      fs.utimesSync(path.join(path.dirname(entry), name), past, past);
    const cache: ManifestCache = new Map();
    const reads = vi.spyOn(fs, "readFileSync");
    const readFiles = () => reads.mock.calls.map(([file]) => path.basename(String(file)));
    expect([...readMessageManifest(entry, cache).keys()]).toEqual(["hello", "bye"]);
    expect(readFiles()).toEqual(["messages.js", "hello.js", "bye.js"]);
    reads.mockClear();
    await writeFile(
      path.join(path.dirname(entry), "messages/bye.js"),
      "export const goodbye = () => 'Goodbye';",
    );
    expect([...readMessageManifest(entry, cache).keys()]).toEqual(["hello", "goodbye"]);
    expect(readFiles()).toEqual(["bye.js"]);
    await writeFile(entry, "export * from './messages/hello.js';");
    expect([...readMessageManifest(entry, cache).keys()]).toEqual(["hello"]);
    expect([...cache.keys()].map((file) => path.basename(file)).sort()).toEqual([
      "hello.js",
      "messages.js",
    ]);
  });

  it("compares recently written modules whose stat did not change", async () => {
    const entry = await fixture({
      "messages.js": "export * from './messages/color.js';",
      "messages/color.js": "export const color_red = () => 'Red';",
    });
    const file = path.join(path.dirname(entry), "messages/color.js");
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(entry, past, past);
    const written = fs.statSync(file, { bigint: true });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Number(written.mtimeNs / 1_000_000n) + 500);
    const cache: ManifestCache = new Map();
    expect([...readMessageManifest(entry, cache).keys()]).toEqual(["color_red"]);
    // A coarse timestamp can keep every stat field across a same-size rewrite.
    await writeFile(file, "export const color_tan = () => 'Tan';");
    const statSync = fs.statSync;
    vi.spyOn(fs, "statSync").mockImplementation(((target: fs.PathLike, options?: never) =>
      target === file ? written : statSync(target, options)) as typeof fs.statSync);
    expect([...readMessageManifest(entry, cache).keys()]).toEqual(["color_tan"]);
    // After the timestamp step has passed, the stat alone identifies the content.
    vi.setSystemTime(Number(written.mtimeNs / 1_000_000n) + 5_000);
    expect([...readMessageManifest(entry, cache).keys()]).toEqual(["color_tan"]);
    const reads = vi.spyOn(fs, "readFileSync");
    expect([...readMessageManifest(entry, cache).keys()]).toEqual(["color_tan"]);
    expect(reads).not.toHaveBeenCalled();
  });

  it("still rejects referenced modules that have not been written yet", async () => {
    const entry = await fixture({
      "messages.js": "export * from './messages/hello.js';",
      "messages/hello.js": "// Generation is in progress.",
    });
    expect(() => readMessageManifest(entry)).toThrow(/has no exports yet/);
  });
});
