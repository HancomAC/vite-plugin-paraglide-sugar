import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import paraglideSugar from "vite-plugin-paraglide-sugar";

assert.throws(() => createRequire(import.meta.url).resolve("svelte"), /Cannot find module/);
const root = path.dirname(fileURLToPath(import.meta.url));
const result = await build({
  root,
  configFile: false,
  logLevel: "silent",
  plugins: [
    paraglideSugar({
      outdir: "src/generated",
      importSource: "#app/messages",
      exportName: "text",
    }),
  ],
  resolve: { alias: { "#app/messages": path.join(root, "src/i18n.ts") } },
  build: {
    write: false,
    minify: false,
    lib: { entry: path.join(root, "src/plain.ts"), formats: ["es"] },
  },
});
const chunks = (Array.isArray(result) ? result : [result])
  .flatMap((bundle) => bundle.output)
  .filter((item) => item.type === "chunk");
const entry = chunks.find((chunk) => chunk.isEntry);
const { greeting, welcome } = await import(
  `data:text/javascript;base64,${Buffer.from(entry.code).toString("base64")}`
);
assert.equal(greeting, "Hello");
assert.equal(welcome, "Welcome, Ada");
assert.ok(!chunks.some((chunk) => chunk.code.includes("UNUSED_TRANSLATION_SENTINEL")));
console.log("Packed consumer: JS/TS build without Svelte installed passed.");
