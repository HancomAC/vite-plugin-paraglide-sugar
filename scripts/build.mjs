import { copyFile, readFile, writeFile } from "node:fs/promises";
import { build } from "esbuild";

// Bundle parser consumers so their external TypeScript import resolves beside
// this plugin, rather than letting npm hoist them beside native TypeScript 7.
await build({
  entryPoints: ["src/vite.ts"],
  outdir: "dist",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: true,
  external: ["typescript", "vite", "svelte", "svelte/*"],
  banner: {
    js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
  },
});
// Remove package-manager-specific paths from bundled dependency source maps.
const mapPath = new URL("../dist/vite.js.map", import.meta.url);
const map = JSON.parse(await readFile(mapPath, "utf8"));
map.sources = map.sources.map((source) => {
  const index = source.lastIndexOf("node_modules/");
  return index < 0 ? source : `npm:${source.slice(index + "node_modules/".length)}`;
});
await writeFile(mapPath, JSON.stringify(map));

await copyFile(
  new URL("../src/virtual.d.ts", import.meta.url),
  new URL("../dist/virtual.d.ts", import.meta.url),
);
await writeFile(new URL("../dist/virtual.js", import.meta.url), "export {};\n");
