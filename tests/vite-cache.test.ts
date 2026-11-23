import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createBuilder, createLogger } from "vite";
import { describe, expect, it, vi } from "vitest";
import { transformMessages } from "../src/transform.js";
import { paraglideSugar } from "../src/vite.js";

vi.mock("../src/transform.js", { spy: true });

const source = `import { m } from '#messages'; export const text = [m.label, m.extra];`;
const changedSource = source + `\nexport const changed = true;`;
const originalCatalog = `export { hello as label, unused } from './messages/original.js';`;
const changedCatalog = `export { hello as label, extra } from './messages/replacement.js';`;
const runtime = path.resolve(import.meta.dirname, "../src/runtime.ts");

async function buildBoth(revise: "same catalog" | "new catalog" | "new source") {
  const root = await mkdtemp(path.join(tmpdir(), "paraglide-sugar-cache-"));
  vi.mocked(transformMessages).mockClear();
  try {
    const files = {
      "package.json": '{ "type": "module" }',
      "src/marker.js": "export const m = {};",
      "src/entry.js": source,
      "generated/messages.js": originalCatalog,
      "generated/messages/original.js": `export const hello = () => 'SSR translation'; export const unused = () => 'Unused';`,
      "generated/messages/replacement.js": `export const hello = () => 'Client translation'; export const extra = () => 'New key';`,
    };
    for (const [relative, contents] of Object.entries(files)) {
      const file = path.join(root, relative);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, contents);
    }

    const entry = path.join(root, "src/entry.js");
    const index = path.join(root, "generated/messages.js");
    const logger = createLogger("silent");
    const warn = vi.spyOn(logger, "warn");
    const results: { code: string; sourcesContent?: (string | null)[] }[] = [];
    const builder = await createBuilder({
      configFile: false,
      root,
      logLevel: "silent",
      customLogger: logger,
      plugins: [
        paraglideSugar({ outdir: "generated", importSource: "#messages", missingKey: "undefined" }),
      ],
      resolve: {
        alias: {
          "#messages": path.join(root, "src/marker.js"),
          "vite-plugin-paraglide-sugar/runtime": runtime,
        },
      },
      build: {
        write: false,
        sourcemap: true,
        minify: false,
        rolldownOptions: { input: entry, preserveEntrySignatures: "strict" },
      },
      environments: { ssr: { build: { ssr: true } }, client: {} },
      builder: {
        sharedConfigBuild: true,
        sharedPlugins: true,
        async buildApp(builder) {
          for (const env of ["ssr", "client"]) {
            if (env === "client") {
              // Regenerating the catalog between environments replaces its manifest object.
              await writeFile(index, revise === "new catalog" ? changedCatalog : originalCatalog);
              if (revise === "new source") await writeFile(entry, changedSource);
            }
            const result = await builder.build(builder.environments[env]!);
            if (!("output" in result)) throw new Error("Expected one Vite build output");
            const chunk = result.output.find((file) => file.type === "chunk" && file.isEntry);
            if (chunk?.type !== "chunk") throw new Error("Missing entry bundle");
            results.push({ code: chunk.code, sourcesContent: chunk.map?.sourcesContent });
          }
        },
      },
    });

    await builder.buildApp();
    return {
      results,
      parses: vi.mocked(transformMessages).mock.calls.filter(([, file]) => file === entry).length,
      warnings: warn.mock.calls
        .map(([message]) => message)
        .filter((message) => message.includes('Unknown message key "extra"')),
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("shared Vite build transforms", () => {
  it("reuses one parse across SSR and client and reports missing keys in both", async () => {
    const { results, parses, warnings } = await buildBoth("same catalog");
    expect(parses).toBe(1);
    expect(warnings).toHaveLength(2);
    for (const result of results) {
      expect(result.code).toContain("SSR translation");
      expect(result.sourcesContent).toContain(source);
    }
  });

  it("reparses when an export moves or a previously missing key becomes available", async () => {
    const { results, parses, warnings } = await buildBoth("new catalog");
    expect(parses).toBe(2);
    expect(warnings).toHaveLength(1);
    const [ssr, client] = results;
    expect(ssr!.code).toContain("SSR translation");
    expect(client!.code).toContain("Client translation");
    expect(client!.code).toContain("New key");
  });

  it("reparses when the same filename reaches the client with different source", async () => {
    const { results, parses } = await buildBoth("new source");
    expect(parses).toBe(2);
    expect(results[1]!.sourcesContent).toContain(changedSource);
  });
});
