# vite-plugin-paraglide-sugar

A Vite plugin that compiles property-style [Paraglide](https://paraglidejs.com/) message
access, such as `m.greeting` and `m.welcome._({ name })`, into direct imports of the
individual generated message functions. Translation still happens when the expression
runs; the plugin only decides at build time which message modules each file needs.

It supports JavaScript, TypeScript, and Svelte source files. It reads the exports that
Paraglide generates, so it works independently of the format used to store translations.
It does not rename message keys or parse translation files.

## Why

With plain Paraglide, application code imports the generated catalog and calls every
message:

```ts
import { m } from "./paraglide/messages.js";

m.greeting();
m.welcome({ name });
```

With this plugin:

```ts
import { m } from "$messages";

m.greeting;
m.welcome._({ name });
```

What changes:

- Messages without inputs are read as properties. Messages with inputs are called through
  `._`.
- Application code imports a stable alias module (`$messages`) instead of a path into the
  generated output.
- Every static access compiles to a direct import of that one message module. Route-level
  code splitting therefore does not depend on the bundler tree-shaking a namespace
  object, and the development server loads only the message modules a page uses.
  Importing Paraglide's `messages.js` in development loads every message module through
  its barrel.
- Unknown keys fail the build in JavaScript, TypeScript, and Svelte templates.
- Computed keys use bounded groups of messages selected by a literal key prefix (see
  [Dynamic keys](#dynamic-keys)).

## What it compiles to

Input:

```ts
import { m } from "$messages";

const title = m.greeting;
const text = m.welcome._({ name });
```

Output:

```ts
import { greeting as __paraglide_sugar_0 } from "/app/src/paraglide/messages/greeting.js";
import { resolveMessage as __paraglide_sugar_1 } from "vite-plugin-paraglide-sugar/runtime";
import { welcome as __paraglide_sugar_2 } from "/app/src/paraglide/messages/welcome.js";

const title = __paraglide_sugar_1(__paraglide_sugar_0);
const text = __paraglide_sugar_2({ name });
```

The import paths in real output are the absolute paths of the generated files; `/app`
stands in for the project root here. `resolveMessage` calls a message function without
inputs and returns `{ _: messageFunction }` for one with inputs (see
[Reading messages](#reading-messages)). The `._` form imports the function and calls it
directly. A key that is not a valid JavaScript identifier, such as `m["footer.terms"]`,
compiles to a namespace import of that single message module followed by a static
property read.

## Install

```sh
npm install -D vite-plugin-paraglide-sugar
```

```sh
pnpm add -D vite-plugin-paraglide-sugar
```

```sh
yarn add -D vite-plugin-paraglide-sugar
```

The package contains built ESM JavaScript and TypeScript declarations; consumers do not
load its TypeScript source files.

Requirements:

| Dependency                  | Supported versions       |
| --------------------------- | ------------------------ |
| Node.js                     | `^22.12.0 \|\| >=24.0.0` |
| Vite                        | `^8.0.14`                |
| `@inlang/paraglide-js`      | `^2.20.1`                |
| Svelte, for `.svelte` files | `^5.53.6`                |

Paraglide 2.20.1 is the verified minimum, including generated TypeScript declarations for
quoted and dotted message keys. Earlier compiler versions can emit invalid declarations
for these keys.

Svelte is an optional peer dependency. JavaScript and TypeScript projects do not need to
install it.

To build and install the package from source, see [CONTRIBUTING.md](./CONTRIBUTING.md).

## Set up

Run Paraglide before the sugar plugin, and the sugar plugin before your Svelte
integration. Configure Paraglide to generate `message-modules` in both development and
production.

```ts
// vite.config.ts
import { fileURLToPath } from "node:url";
import { paraglideVitePlugin } from "@inlang/paraglide-js";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";
import paraglideSugar from "vite-plugin-paraglide-sugar";

export default defineConfig({
  resolve: {
    alias: {
      $messages: fileURLToPath(new URL("./src/messages.ts", import.meta.url)),
    },
  },
  plugins: [
    paraglideVitePlugin({
      project: "./project.inlang",
      outdir: "./src/paraglide",
      outputStructure: "message-modules",
    }),
    paraglideSugar({
      outdir: "./src/paraglide",
      importSource: "$messages",
    }),
    svelte(),
  ],
});
```

For SvelteKit, see [SvelteKit](#sveltekit). For a JavaScript or TypeScript project
without Svelte, omit the Svelte plugin.

Create the module that application code imports:

```ts
// src/messages.ts
import { createMessages } from "vite-plugin-paraglide-sugar/runtime";

export const m = createMessages<typeof import("./paraglide/messages.js")>();
```

The type argument supplies message keys, input types, and locale options without
importing the catalog at runtime. Non-function exports, such as Paraglide's `m` namespace,
are excluded from the resulting type.

`createMessages()` is a marker for the transform. It throws on any property read at
runtime, which makes a missing plugin or an excluded source directory visible. Use
Paraglide's generated functions directly in code that runs outside Vite.

The default export and the named `paraglideSugar` export are available from both
`vite-plugin-paraglide-sugar` and `vite-plugin-paraglide-sugar/vite`.

### TypeScript

`typeof import("./paraglide/messages.js")` needs type information for Paraglide's
generated JavaScript. Provide it in one of two ways:

- enable `allowJs` in `tsconfig.json`, so TypeScript reads the JSDoc types in the
  generated files; or
- set Paraglide's `emitTsDeclarations: true` option, so Paraglide writes `.d.ts` files
  next to them.

Resolve the `$messages` alias for type checking as well:

```jsonc
// tsconfig.json
{
  "compilerOptions": {
    "allowJs": true,
    "paths": {
      "$messages": ["./src/messages.ts"],
    },
  },
}
```

## SvelteKit

SvelteKit passes `kit.alias` to both Vite and its generated `tsconfig.json`, so no
`resolve.alias` or `paths` entry is needed:

```js
// svelte.config.js
/** @type {import("@sveltejs/kit").Config} */
const config = {
  kit: {
    // adapter and other options
    alias: {
      $messages: "src/lib/messages.ts",
    },
  },
};

export default config;
```

```ts
// vite.config.ts
import { paraglideVitePlugin } from "@inlang/paraglide-js";
import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";
import paraglideSugar from "vite-plugin-paraglide-sugar";

export default defineConfig({
  plugins: [
    paraglideVitePlugin({
      project: "./project.inlang",
      outdir: "./src/lib/paraglide",
      outputStructure: "message-modules",
    }),
    paraglideSugar({
      outdir: "./src/lib/paraglide",
      importSource: "$messages",
    }),
    sveltekit(),
  ],
});
```

```ts
// src/lib/messages.ts
import { createMessages } from "vite-plugin-paraglide-sugar/runtime";

export const m = createMessages<typeof import("./paraglide/messages.js")>();
```

The default `sourceRoots: ['src']` already covers `src/lib` and `src/routes`. Import `m`
from `$messages` everywhere, not from `$lib/messages`: only the exact `importSource`
specifier is transformed. The [TypeScript](#typescript) requirement for the generated
types still applies.

## Reading messages

```svelte
<script lang="ts">
  import { m } from '$messages';
</script>

<h1>{m.greeting}</h1>
<p>{m.welcome._({ name: 'Ada' })}</p>
<p>{m.welcome._({ name: 'Ada' }, { locale: 'en' })}</p>
```

| Expression                                | Result                                                 |
| ----------------------------------------- | ------------------------------------------------------ |
| `m.greeting` (no inputs)                  | The translated string, evaluated on every read         |
| `m.welcome` (has inputs)                  | `{ _: welcome }`, without calling the message function |
| `m.greeting._`, `m.welcome._`             | The original Paraglide message function                |
| `m.welcome._({ name })`                   | The translated string                                  |
| `m.welcome._({ name }, { locale: "en" })` | The translated string in that locale                   |

A bare property read uses the generated function's `length`: when it is `0`, the function
runs on every read; otherwise the result is `{ _: messageFunction }` without invocation.
This follows Paraglide's generated signatures and does not infer optional arguments for
arbitrary hand-written functions. Prefer the explicit `._` form when supplying inputs or
locale options; it exposes the original callable and forwards its arguments unchanged.

The `._` suffix must be part of the static message access. For a message without inputs,
`const text = m.greeting; text._()` is unsupported because `text` already contains the
translated string. Save the callable instead:

```ts
const greeting = m.greeting._;
const title = greeting();
```

Messages resolve their locale at invocation time. The plugin does not cache translations
or subscribe components to locale changes; keep your application's normal locale and
reactivity integration. Message exceptions propagate to the caller.

Static brackets, renamed imports, `const` aliases, and TypeScript assertions are
supported:

```ts
import { m as text } from "$messages";

const labels = text;
const greeting = labels["greeting"];
const welcome = labels.welcome._({ name: "Ada" });
```

The transform follows lexical scope, including Svelte template scopes such as `{#each}`
and snippet parameters and `{@const labels = m}` aliases. It keeps type references and
source maps, and leaves unrelated variables, comments, and strings unchanged.

## Dynamic keys

Use a literal prefix to import a bounded group of callable messages:

```ts
import { messages } from "virtual:paraglide-sugar/messages/status_";

const label = messages[`status_${status}`]?.() ?? "Unknown";
```

Keys retain their full names: `status_ready`, for example, is indexed as
`messages.status_ready`. Every generated key starting with the prefix is included.
Unknown keys yield `undefined`. Choose a narrow prefix to limit the messages included in
the group. The prefix must be nonempty and contain only letters, numbers, `_`, `.`, `$`,
or `-`.

Opt in to the virtual module declarations in your application's declaration file:

```ts
// src/app.d.ts
import "vite-plugin-paraglide-sugar/virtual";
```

Virtual groups have the type
`Readonly<Record<string, ((...args: any[]) => string) | undefined>>`. Use static `m.key._`
access when you need per-message input checking.

## Rules and limitations

The configured `importSource` must be imported by its exact specifier, from a file inside
`sourceRoots`. Every runtime use of the imported message object must be a static property
access, so the compiler can determine the required message modules. The following are
rejected at build time:

- dynamic keys, such as `m[key]`;
- destructuring, such as `const { greeting } = m`;
- `let` and `var` aliases, such as `let labels = m`;
- aliases built from expressions, such as `cond ? m : other` or `(0, m)`;
- passing `m` itself to a function, or storing it in an object or array;
- `"key" in m`;
- assignment, `delete`, `++`/`--`, and Svelte `bind:` on messages;
- namespace, default, or dynamic `import()` imports of the `importSource`;
- re-exporting `m`, directly, through an alias, or with `export * from "$messages"`.

Pass only the messages a helper needs. Getters keep translation lazy:

```ts
validate(value, {
  get required() {
    return m.validation_required;
  },
  get invalid() {
    return m.validation_invalid;
  },
});
```

Type-only use, such as `typeof m` or `import type { m } from "$messages"`, is allowed.

Transformed file types are `.js`, `.mjs`, `.cjs`, `.ts`, `.mts`, `.cts`, `.jsx`, `.tsx`,
and `.svelte`, including `.svelte.js` and `.svelte.ts` modules. Other file types, such as
`.vue`, `.astro`, and `.mdx`, are not transformed.

### Build-time check for uncompiled imports

During `vite build`, if any module still imports the message object at runtime, the build
fails and names the importing file and specifier. This happens when the object is
imported through a different specifier, such as a relative `./messages.js` or
`$lib/messages`, or from a file outside `sourceRoots`.

The development server and Vitest do not run this check. There, an untransformed access
throws `Uncompiled message access <key>` when it runs.

## Options

| Option          | Default       | Meaning                                                                                                                                   |
| --------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `outdir`        | Required      | Paraglide output directory, relative to the Vite root.                                                                                    |
| `importSource`  | Required      | Exact module specifier from which the message object is imported, such as `$messages`.                                                    |
| `exportName`    | `'m'`         | Named export to transform. Renaming it at an import site is supported.                                                                    |
| `sourceRoots`   | `['src']`     | Source directories to transform, relative to the Vite root. Include shared package source directories here.                               |
| `missingKey`    | `'error'`     | Fail for an unknown static key. Set `'undefined'` to emit `undefined` and a warning, allowing optional chaining and fallback expressions. |
| `messagesEntry` | Auto-detected | Generated entry path relative to `outdir`. By default, the plugin finds `messages.js` or `messages/_index.js`.                            |

The message manifest is built from actual ESM exports, including re-exports and quoted
names. `messagesEntry` can select another generated barrel with the same message-module
structure; it does not enable locale-module output.

If a custom entry exports only an `m` namespace, select it for the marker's type:
`createMessages<typeof import("./paraglide/messages.js").m>()`. The standard generated
entry exports message functions directly and uses the setup above.

Source roots are resolved through symbolic links unless Vite's `resolve.preserveSymlinks`
is enabled.

## Development server

When generated message modules change, the plugin invalidates the affected modules and
virtual groups in every Vite environment (client, SSR, and custom environments such as
worker runtimes), then triggers a full reload. Paraglide writes its output in several
steps, so the plugin waits for complete generated output before rebuilding its message
list.

In `vite build --watch`, the message list is read again on the next rebuild.

## Testing with Vitest

Vitest uses your Vite configuration, so the plugin applies to test runs. If you use a
separate `vitest.config.ts`, include the same plugins there. The generated Paraglide
output must exist: keep `paraglideVitePlugin` in the configuration, or run the Paraglide
compiler before the tests. Test files that import `$messages` directly must be inside
`sourceRoots`.

Tools that load source files without the Vite configuration, such as plain Node.js
scripts, must import Paraglide's generated functions directly.

## Troubleshooting

**`Uncompiled message access <key>`**: the access was not transformed. The file is
outside `sourceRoots`, imports the message object through a specifier other than the
exact `importSource` or under an export name other than `exportName`, or was loaded by a
tool that does not use the Vite configuration.

**`Unknown message key "<key>"`**: the key is not in the generated output. Run Paraglide,
and check that `outdir` points at its output directory. Keys keep their exact generated
names, including case and dots, for example `m["footer.terms"]`. To allow missing keys
with a warning, set `missingKey: 'undefined'`.

**`must use Paraglide outputStructure: 'message-modules'`**: Paraglide generated
locale-module output, which defines every message in one module. Set
`outputStructure: "message-modules"` in the Paraglide configuration for both development
and production.

**`Cannot read ... Run Paraglide before paraglideSugar`**: the generated output is
missing. Place `paraglideVitePlugin` before `paraglideSugar` in `plugins`, or run the
Paraglide compiler first, and check `outdir` and `messagesEntry`.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

[MIT](./LICENSE)
