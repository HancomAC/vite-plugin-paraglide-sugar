import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer, type ViteDevServer } from "vite";
import { describe, expect, it } from "vitest";
import { paraglideSugar } from "../src/vite.js";

const packageRoot = path.resolve(import.meta.dirname, "..");

describe("worker source requests", () => {
  it("translates the worker URL emitted by Vite and executes its TypeScript module", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "paraglide-sugar-worker-"));
    let server: ViteDevServer | undefined;
    try {
      const files = {
        "package.json": '{"type":"module"}',
        "generated/messages.js": "export * from './messages/hello.js';",
        "generated/messages/hello.js": "export const hello = () => 'Hello from the worker';",
        "src/messages.js":
          "import { createMessages } from 'vite-plugin-paraglide-sugar/runtime'; export const m = createMessages();",
        "src/worker.ts": "import { m } from '#messages'; export const greeting: string = m.hello;",
        "src/main.js": "new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });",
      };
      for (const [relative, code] of Object.entries(files)) {
        const file = path.join(root, relative);
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, code);
      }
      server = await createServer({
        root,
        configFile: false,
        logLevel: "silent",
        server: { middlewareMode: true, hmr: false },
        optimizeDeps: { noDiscovery: true, include: [] },
        resolve: {
          alias: {
            "#messages": path.join(root, "src/messages.js"),
            "vite-plugin-paraglide-sugar/runtime": path.join(packageRoot, "src/runtime.ts"),
          },
        },
        plugins: [paraglideSugar({ outdir: "generated", importSource: "#messages" })],
      });
      const main = await server.transformRequest("/src/main.js");
      const workerUrl = main!.code.match(/"([^"\n]+\?worker_file&type=module)"/)?.[1];
      expect(workerUrl).toBeDefined();
      const transformed = await server.transformRequest(workerUrl!);
      expect(transformed!.code).toContain("/generated/messages/hello.js");
      expect(transformed!.code).not.toContain("/src/messages.js");
      const worker = await server.ssrLoadModule(workerUrl!);
      expect(worker.greeting).toBe("Hello from the worker");
    } finally {
      await server?.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    "worker.ts?raw",
    "worker.ts?url",
    "worker.ts?worker",
    "worker.ts?sharedworker&inline",
    "worker.ts?worker_file&type=module&raw",
    "Component.svelte?svelte&type=style&lang.css",
    "Component.svelte?svelte&type=script",
  ])("leaves non-source requests alone: %s", async (relative) => {
    const plugin = paraglideSugar({ outdir: "generated", importSource: "#messages" });
    const hook = plugin.transform!;
    const transform = typeof hook === "function" ? hook : hook.handler;
    const source = "import { m } from '#messages'; export const value = m.hello;";
    expect(await transform.call({} as never, source, path.resolve("src", relative))).toBeNull();
  });
});
