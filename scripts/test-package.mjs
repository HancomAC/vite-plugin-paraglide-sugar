import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { compileCatalog } from "../tests/fixtures/compile-catalog.mjs";

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporary = await mkdtemp(path.join(tmpdir(), "paraglide-sugar-package-"));
const consumer = path.join(temporary, "consumer");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));

async function run(command, args, cwd) {
  try {
    const result = await exec(command, args, {
      cwd,
      timeout: 600_000,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, npm_config_update_notifier: "false" },
    });
    return result.stdout;
  } catch (error) {
    // Keep failure output bounded when this script runs in a CI or task log.
    for (const output of [error.stdout, error.stderr]) {
      const excerpt = String(output ?? "")
        .replace(/data:[^\s)]+/g, "[data URL]")
        .slice(-12_000);
      if (excerpt) console.error(excerpt);
    }
    const status = error.code ?? error.signal ?? "unknown status";
    throw new Error(`${path.basename(command)} failed (${status}); see bounded diagnostics above.`);
  }
}

try {
  const packed = JSON.parse(
    await run(npm, ["pack", "--json", "--pack-destination", temporary], root),
  )[0];
  const packedPaths = packed.files.map((file) => file.path);
  assert.ok(packedPaths.includes(packageJson.exports["."].import.replace("./", "")));
  assert.ok(packedPaths.includes(packageJson.exports["."].types.replace("./", "")));
  assert.ok(packedPaths.includes("dist/runtime.js"));
  assert.ok(packedPaths.includes("dist/runtime.d.ts"));
  for (const document of ["CHANGELOG.md", "CONTRIBUTING.md", "SECURITY.md", "RELEASING.md"]) {
    assert.ok(packedPaths.includes(document), `Missing published document ${document}`);
  }
  assert.ok(!packedPaths.some((file) => file.startsWith("src/") || file.startsWith("tests/")));
  assert.ok(!packedPaths.some((file) => file.endsWith(".ts") && !file.endsWith(".d.ts")));

  await cp(path.join(root, "tests/fixtures/consumer"), consumer, { recursive: true });
  await writeFile(
    path.join(consumer, "package.json"),
    JSON.stringify({
      name: "paraglide-sugar-installed-consumer",
      private: true,
      type: "module",
    }),
  );
  for (const [filename, contents] of Object.entries(await compileCatalog())) {
    const destination = path.join(consumer, "src/generated", filename);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, contents);
  }
  await run(
    npm,
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--package-lock=false",
      path.join(temporary, packed.filename),
      ...["vite", "@inlang/paraglide-js", "typescript"].map(
        (name) => `${name}@${packageJson.devDependencies[name] ?? packageJson.dependencies[name]}`,
      ),
    ],
    consumer,
  );
  // npm installs required peers automatically; the plugin must not bring ESLint.
  assert.ok(!existsSync(path.join(consumer, "node_modules/eslint")), "ESLint was installed");
  console.log((await run(process.execPath, ["verify-without-svelte.mjs"], consumer)).trim());
  await run(
    npm,
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--package-lock=false",
      ...["svelte", "@sveltejs/vite-plugin-svelte"].map(
        (name) => `${name}@${packageJson.devDependencies[name]}`,
      ),
    ],
    consumer,
  );
  await run(process.execPath, ["node_modules/typescript/bin/tsc", "-p", "tsconfig.json"], consumer);
  console.log(
    "Packed consumer: generated catalog types, subpath exports, and virtual declarations passed.",
  );
  console.log((await run(process.execPath, ["verify.mjs"], consumer)).trim());
  console.log(
    `Packed ${packed.filename}: ${packed.files.length} files, ${packed.size} compressed bytes.`,
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
