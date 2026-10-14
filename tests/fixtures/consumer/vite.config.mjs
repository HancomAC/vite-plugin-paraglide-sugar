import path from "node:path";
import { fileURLToPath } from "node:url";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";
import paraglideSugar from "vite-plugin-paraglide-sugar";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig(({ isSsrBuild }) => ({
  root,
  logLevel: "silent",
  plugins: [
    paraglideSugar({
      outdir: "src/generated",
      importSource: "#app/messages",
      exportName: "text",
    }),
    svelte(),
  ],
  resolve: {
    alias: { "#app/messages": path.join(root, "src/i18n.ts") },
  },
  ssr: { noExternal: true },
  build: {
    outDir: isSsrBuild ? "dist/server" : "dist/client",
    emptyOutDir: true,
    minify: false,
    ...(isSsrBuild
      ? { ssr: path.join(root, "src/server.ts") }
      : {
          lib: {
            entry: path.join(root, "src/main.ts"),
            formats: ["es"],
            fileName: "consumer",
          },
        }),
    rollupOptions: { external: [/^node:/], output: { format: "es" } },
  },
}));
