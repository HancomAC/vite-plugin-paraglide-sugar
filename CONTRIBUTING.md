# Contributing

Bug reports and pull requests are welcome. For a bug, open an issue with a minimal
reproduction: the Vite configuration, the source that fails, and the error or incorrect
output. Report security problems privately as described in [SECURITY.md](./SECURITY.md).

## Prerequisites

- Node.js `^22.12.0 || >=24.0.0`.
- pnpm 10, through Corepack. The exact version is pinned in the `packageManager` field of
  `package.json`. Run `corepack enable` once; if your Node.js installation does not include
  Corepack, install it with `npm install -g corepack`.

## Setup

```sh
git clone https://github.com/HancomAC/vite-plugin-paraglide-sugar.git
cd vite-plugin-paraglide-sugar
pnpm install --frozen-lockfile
```

## Scripts

| Command             | What it does                                                                     |
| ------------------- | -------------------------------------------------------------------------------- |
| `pnpm check`        | Type-checks `src/` and `tests/` with `tsc`.                                      |
| `pnpm lint`         | Runs oxlint on `src/`, `tests/`, and `scripts/`.                                 |
| `pnpm format:check` | Checks formatting with oxfmt. `pnpm format` rewrites files.                      |
| `pnpm test`         | Runs the unit and Vite integration tests with Vitest.                            |
| `pnpm build`        | Compiles `src/` to `dist/` and copies the virtual module declarations.           |
| `pnpm test:package` | Packs the plugin, installs it with npm into a temporary consumer, and builds it. |

`pnpm test:package` installs the packed archive and its peer dependencies from the npm
registry, so it needs registry access. CI runs `format:check`, `lint`, `check`, `build`,
`test`, and `test:package` on Node.js 22 and 24.

## Build and install from source

```sh
pnpm build
pnpm pack
```

Install the resulting `.tgz` file in an application, for example with
`npm install -D /absolute/path/to/vite-plugin-paraglide-sugar-0.1.0.tgz` or
`pnpm add -D /absolute/path/to/vite-plugin-paraglide-sugar-0.1.0.tgz`. The archive
contains built ESM JavaScript and TypeScript declarations; consumers do not load the
TypeScript sources.

## Project layout

| Path                      | Contents                                                                                                    |
| ------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `src/vite.ts`             | Plugin options and hooks: manifest loading, virtual groups, the transform hook, and dev-server invalidation |
| `src/transform.ts`        | Scope-aware rewrite of message accesses in JavaScript, TypeScript, and Svelte sources                       |
| `src/manifest.ts`         | Reader for the ESM exports of Paraglide's generated message modules                                         |
| `src/runtime.ts`          | The `createMessages()` marker and the `resolveMessage()` runtime helper                                     |
| `src/virtual.d.ts`        | Type declarations for `virtual:paraglide-sugar/messages/*`                                                  |
| `tests/`                  | Unit tests and Vite integration tests                                                                       |
| `tests/fixtures/consumer` | Consumer project used by `pnpm test:package` to test the packed package                                     |
| `scripts/`                | Build and package-test scripts                                                                              |

## Commits

Maintainers preparing an npm version should follow [RELEASING.md](./RELEASING.md).

Use [Conventional Commits](https://www.conventionalcommits.org/) messages, for example
`fix: ...`, `feat: ...`, `docs: ...`, `perf: ...`, `refactor: ...`, or `test: ...`. Keep
each commit to one coherent change.

## Pull requests

Before opening a pull request, check that:

- behaviour changes and bug fixes include tests;
- `pnpm format:check`, `pnpm lint`, `pnpm check`, `pnpm build`, `pnpm test`, and
  `pnpm test:package` pass;
- `README.md` and `CHANGELOG.md` are updated for user-facing changes.
