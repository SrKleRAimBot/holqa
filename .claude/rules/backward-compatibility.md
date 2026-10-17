# Backward compatibility

- Treat as public contract: everything exported from a package's `src/index.ts`, the `exports`/`bin` fields of `package.json`, diagnostic codes, CLI flags, exit codes and `--json` output shapes, the resource ID grammar, and canonical JSON output.
- Before changing any of these, explain the compatibility implication in your summary: what breaks, who is affected, the SemVer impact (patch, minor, major), and the migration path.
- All packages are currently `private` at `0.0.0`, but design changes as if they were published: prefer additive changes over breaking ones.
- Never rename, remove, or reuse a diagnostic code. Add a new code and deprecate the old one in docs.
- Never change exit codes (`0` success, `1` failure, `2` usage) or the `{"diagnostics":[...]}` JSON error shape of the CLI without a documented breaking change.
- Deprecate before removing: keep the old export, mark it with `@deprecated` and the replacement in JSDoc, and record removal in a changeset.
- Changing canonical JSON output (key order, spacing, number formatting) changes every future fingerprint; treat it as breaking.
- Schema and message compatibility is separate from type compatibility: a change that type-checks can still reject previously persisted data. Call this out explicitly.
- Add a Changeset (`pnpm changeset`) for every user-visible change to a package's behavior or API.
- Add regression tests that pin the preserved behavior when you refactor public code.
- Keep `examples/package-smoke` passing without edits during refactors; needing to change it signals a public break that must be explained.

See the `safe-refactoring` and `release-management` skills.
