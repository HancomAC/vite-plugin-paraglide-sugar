import { copyFile, writeFile } from "node:fs/promises";

await copyFile(
  new URL("../src/virtual.d.ts", import.meta.url),
  new URL("../dist/virtual.d.ts", import.meta.url),
);
await writeFile(new URL("../dist/virtual.js", import.meta.url), "export {};\n");
