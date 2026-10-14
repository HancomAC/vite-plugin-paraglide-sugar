# Changelog

All notable changes to this project are documented in this file. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## 0.1.0 — Unreleased

Initial public release.

### Added

- Compile static message access such as `m.greeting` into a direct import of the
  generated Paraglide message module, with the translation evaluated on every read.
- `._` access to the original Paraglide message function, for messages with inputs and
  explicit locale options.
- Static bracket keys, renamed imports, `const` aliases, TypeScript assertions, and
  Svelte template scopes, including `{@const}` aliases.
- Virtual prefix groups, `virtual:paraglide-sugar/messages/<prefix>`, for bounded
  dynamic keys.
- Build-time errors for unknown message keys and for message access that cannot be
  resolved statically.
- A build-time check that fails `vite build` when a module still reads the message object
  through an import the plugin did not compile, including through re-exports.
- Dev-server invalidation of affected modules and virtual groups across all Vite
  environments when generated message modules change.
