# vite-plugin-paraglide-sugar

Compile `m.greeting` and `m.welcome._({ name: 'Ada' })` into imports of individual
[Paraglide](https://paraglidejs.com/) message functions. Translation still happens
when the expression runs, while Vite can keep message modules with the routes
that use them.

The plugin supports JavaScript, TypeScript, and Svelte source files. It reads
Paraglide's generated exports, so it works independently of the format used to
store translations. It does not rename message keys or parse translation files.

## Build and install from source

```sh
git clone https://github.com/HancomAC/vite-plugin-paraglide-sugar.git
cd vite-plugin-paraglide-sugar
pnpm install --frozen-lockfile
pnpm build
pnpm pack
```

Install the resulting `.tgz` file in your application with
`pnpm add /absolute/path/to/the-package.tgz`. The package contains built ESM
JavaScript and TypeScript declarations; consumers do not load its TypeScript
source files.

Requirements:

| Dependency                  | Supported versions       |
| --------------------------- | ------------------------ |
| Node.js                     | `^22.12.0 \|\| >=24.0.0` |
| Vite                        | `^8.0.14`                |
| `@inlang/paraglide-js`      | `^2.20.1`                |
| Svelte, for `.svelte` files | `^5.53.6`                |

Paraglide 2.20.1 is the verified minimum, including generated TypeScript declarations
for quoted and dotted message keys. Earlier compiler versions can emit invalid
declarations for these keys.

Svelte is an optional peer dependency. JavaScript and TypeScript projects do not
need to install it.

## Configure Vite

Run Paraglide before the sugar plugin, and the sugar plugin before your Svelte
integration. Configure Paraglide to generate `message-modules` in both development
and production.

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

Use `sveltekit()` in place of `svelte()` for SvelteKit, or omit the Svelte plugin
for a JavaScript or TypeScript project. Configure your framework or TypeScript
`paths` to resolve the same `$messages` alias for type checking.

Create the module that application code imports:

```ts
// src/messages.ts
import { createMessages } from "vite-plugin-paraglide-sugar/runtime";

export const m = createMessages<typeof import("./paraglide/messages.js")>();
```

The type argument supplies message keys, input types, and locale options without
importing the catalog at runtime. Non-function exports, such as Paraglide's `m`
namespace, are excluded from the resulting type.

`createMessages()` is a marker for the transform. It throws if a property is read
at runtime, making a missing plugin or an excluded source directory visible. Use
Paraglide's generated functions directly in code that runs outside Vite.

The default export and the named `paraglideSugar` export are available from both
`vite-plugin-paraglide-sugar` and `vite-plugin-paraglide-sugar/vite`.

## Read messages

```svelte
<script lang="ts">
  import { m } from '$messages';
</script>

<h1>{m.greeting}</h1>
<p>{m.welcome._({ name: 'Ada' })}</p>
<p>{m.welcome._({ name: 'Ada' }, { locale: 'en' })}</p>
```

A bare property read uses the generated function's `length`: when it is `0`, the
function runs on every read; otherwise the result is `{ _: messageFunction }`
without invocation. This follows Paraglide's generated signatures and does not
infer optional arguments for arbitrary hand-written functions. Prefer the
explicit `._` form when supplying inputs or locale options; it exposes the
original callable and forwards its arguments unchanged.

The `._` suffix must be part of the static message access. For a no-input message,
`const text = m.greeting; text._()` is unsupported because `text` already contains
the translated string. Save the callable instead:

```ts
const greeting = m.greeting._;
const title = greeting();
```

Messages resolve their locale at invocation time. The plugin does not cache
translations or subscribe components to locale changes; retain your
application's normal locale and reactivity integration. Message exceptions
propagate to the caller.

Static brackets, renamed imports, immutable aliases, and TypeScript assertions
are supported:

```ts
import { m as text } from "$messages";

const labels = text;
const greeting = labels["greeting"];
const welcome = labels.welcome._({ name: "Ada" });
```

The transform follows lexical scope, including Svelte template scopes. It keeps
type references and source maps, and leaves unrelated variables, comments, and
strings unchanged.

## Dynamic keys

Use a literal prefix to import a bounded group of callable messages:

```ts
import { messages } from "virtual:paraglide-sugar/messages/status_";

const label = messages[`status_${status}`]?.() ?? "Unknown";
```

Keys retain their full names: `status_ready`, for example, is indexed as
`messages.status_ready`. Every generated key starting with the prefix is
included. Unknown keys yield `undefined`. Choose a narrow prefix to limit the
messages included in the group. The prefix must be nonempty and contain only
letters, numbers, `_`, `.`, `$`, or `-`.

Opt in to the virtual module declarations in your application's declaration file:

```ts
// src/app.d.ts
import "vite-plugin-paraglide-sugar/virtual";
```

Virtual groups have the type
`Record<string, ((...args: any[]) => string) | undefined>`. Use static `m.key._`
access when you need per-message input checking.

## Transform boundaries

Import the configured message export by name. The plugin reports a build error
for dynamic access such as `m[key]`, mutation, mutable aliases, namespace or
default imports, and passing or re-exporting the complete message object.
These uses prevent the compiler from determining the required message modules.

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

Type-only imports and references such as `typeof m` remain available. Runtime
source files must be inside a configured `sourceRoots` directory.

## Options

| Option          | Default       | Meaning                                                                                                                                   |
| --------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `outdir`        | Required      | Paraglide output directory, relative to the Vite root.                                                                                    |
| `importSource`  | Required      | Exact module specifier from which the message object is imported, such as `$messages`.                                                    |
| `exportName`    | `'m'`         | Named export to transform. Renaming it at an import site is supported.                                                                    |
| `sourceRoots`   | `['src']`     | Source directories to transform, relative to the Vite root. Include shared package source directories here.                               |
| `missingKey`    | `'error'`     | Fail for an unknown static key. Set `'undefined'` to emit `undefined` and a warning, allowing optional chaining and fallback expressions. |
| `messagesEntry` | Auto-detected | Generated entry path relative to `outdir`. By default, the plugin finds `messages.js` or `messages/_index.js`.                            |

The message manifest is built from actual ESM exports, including re-exports and
quoted names. `messagesEntry` can select another generated barrel with the same
message-module structure; it does not enable locale-module output.

If a custom entry exports only an `m` namespace, select it for the marker's type:
`createMessages<typeof import("./paraglide/messages.js").m>()`. The standard
generated entry exports message functions directly and uses the setup above.

During development, changes to generated message modules invalidate affected
consumers and virtual groups, then reload the page. The plugin waits for complete
generated output before rebuilding its manifest.

## Development

```sh
pnpm check
pnpm lint
pnpm format:check
pnpm test
pnpm build
pnpm test:package
```

Tests cover scoped transforms, runtime and type behavior, generated export names,
development invalidation, client and server rendering, and tree shaking. Package
tests install a packed archive in a separate consumer to verify package export
paths and declarations.

## License

[MIT](./LICENSE)
