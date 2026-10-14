# Releasing

The package is published as `vite-plugin-paraglide-sugar` on the public npm registry.
No npm release is created by pushing a commit or a tag. Publishing is an explicit
maintainer action.

## Prepare a version

1. Merge the reviewed changes and passing checks into `main`.
2. Use a clean checkout. Set the version in `package.json` and update `CHANGELOG.md`;
   for the first release the version is already `0.1.0`.
3. Run `pnpm install --frozen-lockfile` and `npm run release:check`.
4. Commit the release metadata, then create and push the matching tag, for example
   `v0.1.0`. Do not tag a checkout with uncommitted changes.

`release:check` verifies formatting, lint, types, the build, tests, the packed file
inventory and package exports, source map paths, and a separately installed consumer.
`npm publish` from the source directory runs it again through `prepublishOnly`.

To inspect the archive without publishing:

```sh
npm pack
npm publish vite-plugin-paraglide-sugar-0.1.0.tgz --dry-run --access public
```

## First publication

The package must exist before its npm package settings can be used to configure a
trusted publisher. A maintainer with an npm account and permission to create the
package performs the initial publication from the reviewed release tag:

```sh
git switch --detach v0.1.0
pnpm install --frozen-lockfile
npm run release:check
npm pack
npm login
npm publish vite-plugin-paraglide-sugar-0.1.0.tgz --access public
```

Complete npm's interactive authentication and 2FA prompts yourself. Never commit an
authentication token or put one in a release issue or log. Publishing the archive
publishes exactly the artifact already checked above. This local first publication
does not attach GitHub Actions provenance.

## Subsequent publications through GitHub Actions

Configure [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) in the
package settings with these GitHub values:

| Field                   | Value                         |
| ----------------------- | ----------------------------- |
| Organization or user    | `HancomAC`                    |
| Repository              | `vite-plugin-paraglide-sugar` |
| Workflow filename       | `publish.yml`                 |
| Environment             | Leave empty                   |
| Allow direct publishing | Enabled                       |

The workflow runs on GitHub-hosted Node.js 24 with npm 11.21.0, uses OIDC instead of
a saved npm token, and publishes with provenance. It checks that the selected tag
matches `package.json` and rebuilds and tests the package from that tag.

Dispatch the workflow against the release tag using the GitHub CLI. First validate and
upload the archive without publishing:

```sh
gh workflow run publish.yml --ref v0.1.0 -f version=0.1.0 -f publish=false
```

Inspect the successful run and its artifact in GitHub Actions. When that version is
approved for publication, dispatch it with publishing enabled:

```sh
gh workflow run publish.yml --ref v0.1.0 -f version=0.1.0 -f publish=true
```

Selecting the matching tag ensures that provenance identifies the package's release
commit. The workflow rejects branch dispatches and mismatched versions.

The tag must already exist. The workflow does not change versions, create tags, merge
PRs or create a GitHub release. `publishConfig` fixes the target registry and public
access. A published name/version cannot be reused; bump the version for another release.
