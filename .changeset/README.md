# Changesets

This directory holds [Changesets](https://github.com/changesets/changesets): small Markdown files that describe a
change to a publishable package and the SemVer bump it requires.

- Add one with `pnpm changeset` whenever you change the behavior or public API of a non-private package.
- Every Holqa package is currently `"private": true`, so Changesets does not version or publish anything yet
  (`privatePackages.version` and `privatePackages.tag` are `false`).
- Publishing is intentionally not automated. See [docs/contributing/releasing.md](../docs/contributing/releasing.md).
