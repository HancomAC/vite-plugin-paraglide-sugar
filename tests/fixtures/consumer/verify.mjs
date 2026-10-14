import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "vite";
import paraglideSugar, { paraglideSugar as named } from "vite-plugin-paraglide-sugar";
import viteEntry from "vite-plugin-paraglide-sugar/vite";
import { createMessages } from "vite-plugin-paraglide-sugar/runtime";

assert.equal(paraglideSugar, named);
assert.equal(viteEntry, named);
assert.throws(() => createMessages().hello, /Uncompiled message access hello/);

const root = path.dirname(fileURLToPath(import.meta.url));
const configFile = path.join(root, "vite.config.mjs");
const browser = await build({ configFile });
const browserChunks = (Array.isArray(browser) ? browser : [browser])
  .flatMap((bundle) => bundle.output)
  .filter((item) => item.type === "chunk");
const browserCode = browserChunks.map((chunk) => chunk.code).join("\n");
assert.ok(browserCode.includes("LAZY_TRANSLATION_SENTINEL"));
assert.ok(!browserCode.includes("UNUSED_TRANSLATION_SENTINEL"));
assert.ok(!browserCode.includes("createMessages"), "the marker module must be removed");

const byFile = new Map(browserChunks.map((chunk) => [chunk.fileName, chunk]));
const visited = new Set();
function initialClosure(filename) {
  if (visited.has(filename)) return "";
  visited.add(filename);
  const chunk = byFile.get(filename);
  assert.ok(chunk, `missing chunk ${filename}`);
  return (
    chunk.code +
    chunk.imports
      .filter((file) => byFile.has(file))
      .map(initialClosure)
      .join("\n")
  );
}
assert.ok(
  !initialClosure(browserChunks.find((chunk) => chunk.isEntry).fileName).includes(
    "LAZY_TRANSLATION_SENTINEL",
  ),
);

const ssr = await build({ configFile, build: { ssr: path.join(root, "src/server.ts") } });
const ssrChunks = (Array.isArray(ssr) ? ssr : [ssr])
  .flatMap((bundle) => bundle.output)
  .filter((item) => item.type === "chunk");
const entry = ssrChunks.find((chunk) => chunk.isEntry);
const { request } = await import(
  pathToFileURL(path.join(root, "dist/server", entry.fileName)).href
);
const english = request("en", "Ada");
assert.equal(english.label, "Hello");
assert.equal(english.welcome, "Welcome, Ada");
assert.equal(english.terms, "Terms");
assert.equal(english.color, "Red");
const korean = request("ko", "<Grace>");
assert.equal(korean.label, "안녕");
assert.equal(korean.welcome, "환영합니다, <Grace>");
assert.equal(korean.terms, "약관");
assert.equal(korean.color, "빨강");
assert.ok(korean.html.includes("<h1>안녕</h1>"));
assert.ok(korean.html.includes("&lt;Grace"));
assert.ok(!korean.html.includes("<Grace>"));
assert.equal(request("en", "Ada").label, "Hello");
console.log(
  "Packed consumer: native ESM imports, client build, SSR, locale changes, escaping, and chunk isolation passed.",
);
