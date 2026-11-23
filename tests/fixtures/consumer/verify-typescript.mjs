import assert from "node:assert/strict";
import { createRequire } from "node:module";

const consumerRequire = createRequire(import.meta.url);
const consumerTypescript = consumerRequire("typescript");
const expectedMajor = Number(process.argv[2]);
assert.equal(Number(consumerTypescript.version.split(".")[0]), expectedMajor);

// The native compiler is the application's choice. The plugin's parser must
// resolve its own compiler API instead of borrowing the consumer's TS7 package.
const pluginRequire = createRequire(import.meta.resolve("vite-plugin-paraglide-sugar"));
const parserTypescript = pluginRequire("typescript");
assert.equal(typeof parserTypescript.createSourceFile, "function");
if (expectedMajor === 7) {
  assert.equal(typeof consumerTypescript.createSourceFile, "undefined");
  assert.notEqual(pluginRequire.resolve("typescript"), consumerRequire.resolve("typescript"));
}
console.log(
  `Consumer TypeScript ${consumerTypescript.version}; isolated parser TypeScript ${parserTypescript.version}.`,
);
