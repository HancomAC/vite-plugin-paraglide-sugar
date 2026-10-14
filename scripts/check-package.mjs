import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporary = await mkdtemp(path.join(tmpdir(), "paraglide-sugar-release-check-"));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

try {
  const metadata = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  assert.notEqual(metadata.private, true, "A private package cannot be published");
  assert.equal(metadata.publishConfig.access, "public");
  assert.equal(metadata.publishConfig.registry, "https://registry.npmjs.org/");
  const { stdout } = await promisify(execFile)(
    npm,
    ["pack", "--json", "--ignore-scripts", "--pack-destination", temporary],
    { cwd: root, timeout: 60_000, maxBuffer: 1024 * 1024 },
  );
  const [packed] = JSON.parse(stdout);
  const files = new Set(packed.files.map((file) => file.path));
  assert.equal(packed.name, metadata.name);
  assert.equal(packed.version, metadata.version);
  const documents = [
    "package.json",
    "README.md",
    "LICENSE",
    "CHANGELOG.md",
    "CONTRIBUTING.md",
    "SECURITY.md",
    "RELEASING.md",
  ];
  for (const document of documents) assert.ok(files.has(document), `Missing ${document}`);
  for (const entry of Object.values(metadata.exports)) {
    for (const target of typeof entry === "string" ? [entry] : Object.values(entry)) {
      assert.ok(files.has(target.replace(/^\.\//, "")), `Missing package export ${target}`);
    }
  }
  for (const file of files) {
    assert.ok(
      documents.includes(file) ||
        /^dist\/(?:manifest|runtime|transform|vite)\.(?:js|d\.ts|js\.map)$/.test(file) ||
        /^dist\/virtual\.(?:js|d\.ts)$/.test(file),
      `Unexpected published file ${file}`,
    );
    if (file.endsWith(".map")) {
      const map = JSON.parse(await readFile(path.join(root, file), "utf8"));
      assert.ok(
        map.sources.every((source) => /^\.\.\/src\/[\w-]+\.ts$/.test(source)),
        `Unexpected source map path in ${file}`,
      );
    }
  }
  console.log(
    JSON.stringify({
      name: packed.name,
      version: packed.version,
      files: [...files].sort(),
      compressedBytes: packed.size,
      integrity: packed.integrity,
    }),
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
