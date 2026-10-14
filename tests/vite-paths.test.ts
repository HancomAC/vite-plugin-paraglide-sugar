import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { build } from "vite";
import { describe, expect, it } from "vitest";
import { paraglideSugar } from "../src/vite.js";

const packageRoot = path.resolve(import.meta.dirname, "..");

describe("symlinked source roots", () => {
  it.each([false, true])(
    "translates linked sources without including neighbors when preserveSymlinks is %s",
    async (preserveSymlinks) => {
      const root = await mkdtemp(path.join(tmpdir(), "paraglide-sugar-paths-"));
      try {
        const files = {
          "package.json": '{"type":"module"}',
          "generated/messages.js": "export * from './messages/hello.js';",
          "generated/messages/hello.js": "export const hello = () => 'Hello from shared';",
          "src/messages.js":
            "import { createMessages } from 'vite-plugin-paraglide-sugar/runtime'; export const m = createMessages();",
          "src/entry.ts":
            "export { value } from '../shared/read.ts'; export { outside } from '../real-shared-other/read.ts';",
          "real-shared/read.ts": "import { m } from '#messages'; export const value = m.hello;",
          "real-shared-other/read.ts":
            "import { m } from '#messages'; export const outside = () => m.hello;",
        };
        for (const [relative, code] of Object.entries(files)) {
          const file = path.join(root, relative);
          await mkdir(path.dirname(file), { recursive: true });
          await writeFile(file, code);
        }
        await symlink(path.join(root, "real-shared"), path.join(root, "shared"), "junction");
        const result = await build({
          root,
          configFile: false,
          logLevel: "silent",
          resolve: {
            preserveSymlinks,
            alias: {
              "#messages": path.join(root, "src/messages.js"),
              "vite-plugin-paraglide-sugar/runtime": path.join(packageRoot, "src/runtime.ts"),
            },
          },
          plugins: [
            paraglideSugar({
              outdir: "generated",
              importSource: "#messages",
              sourceRoots: ["src", "shared", "not-created-yet"],
            }),
          ],
          build: { ssr: "src/entry.ts", write: false, minify: false },
        });
        if ("on" in result) throw new Error("Expected a completed build");
        const entry = (Array.isArray(result) ? result : [result])
          .flatMap((bundle) => bundle.output)
          .find((item) => item.type === "chunk" && item.isEntry);
        if (!entry || entry.type !== "chunk") throw new Error("Missing entry chunk");
        const module = await import(
          `data:text/javascript;base64,${Buffer.from(entry.code).toString("base64")}`
        );
        expect(module.value).toBe("Hello from shared");
        expect(module.outside).toThrow(/Uncompiled message access hello/);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
