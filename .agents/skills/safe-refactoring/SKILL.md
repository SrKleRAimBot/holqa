---
name: safe-refactoring
description: Procedure for changing existing Holqa code without breaking consumers - identifying public surface, assessing and explaining API compatibility, deprecating before removing, moving or renaming modules and updating @/ imports and index re-exports, splitting or adding packages, and validating with boundaries:check, typecheck, the package-smoke example, and pnpm check. Use when renaming, moving, splitting, or deleting code, changing an exported signature or behavior, reorganizing packages or dependencies, or doing any refactor larger than a single function.
---

# Safe refactoring

## Purpose

Refactors in a framework repository can silently break consumers, persisted data, or tooling that matches on diagnostic codes. This skill is a step-by-step procedure for making structural changes small, verifiable, and explicit about compatibility.

## When to use

- Renaming or moving files, modules, exports, or packages.
- Changing a function signature, return type, error behavior, or output format.
- Removing code or splitting a module.
- Changing package dependencies or layout.

## Instructions

### 1. Scope the change

- Do exactly what the task asks. Do not combine a refactor with unrelated behavior changes, style sweeps, or "while I'm here" edits.
- Prefer a sequence of small, independently passing changes over one large rewrite.
- If the refactor touches architecture (package responsibilities, dependency directions), read the `holqa-architecture` skill and relevant ADRs first.

### 2. Identify the public surface

Public, compatibility-relevant surface in this repo:

| Surface | Where |
| --- | --- |
| Exported values and types | `packages/*/src/index.ts` |
| Package entry points and bin | `exports`, `types`, `bin` in `package.json` |
| Diagnostic codes | `packages/core/src/diagnostics/codes.ts` |
| CLI flags, exit codes (0/1/2), `--json` shape | `packages/cli/src/run.ts`, `commands.ts` |
| Resource ID grammar | `packages/core/src/identity/resource-id.ts` |
| Canonical JSON output | `packages/compiler/src/manifest/canonical-json.ts` |

Find usages before changing anything:

```bash
grep -rn "parseResourceId" packages examples scripts docs skills .agents --include="*.ts" --include="*.md"
```

### 3. Classify and explain compatibility

State in your summary, for each public change:

| Change | Kind | Bump before 1.0 | Bump from 1.0 |
| --- | --- | --- | --- |
| Internal-only (not reachable from `index.ts`) | none | none | none |
| New export, new optional parameter/field, new diagnostic code | feature | minor or patch | minor |
| Bug fix that restores documented behavior | fix | patch | patch |
| Removing/renaming an export, adding a required parameter, narrowing accepted input, widening output, changing error type, exit code, or serialized format | breaking | minor | major |
| Renaming, removing, or reusing a diagnostic code | not allowed | — | — |

Even though packages are private at `0.0.0`, write the explanation and add a changeset (`pnpm changeset`) for public-contract changes (see the `release-management` skill).

### 4. Deprecate before removing

```ts
/**
 * Checks an identifier and throws when it is invalid.
 *
 * @deprecated Use {@link parseResourceId}, which returns a diagnostic instead of throwing. Will be removed in the next major version.
 * @param value - The untrusted candidate identifier.
 * @returns The validated identifier.
 * @throws {Error} When `value` does not satisfy the identifier grammar.
 */
export function assertResourceId(value: unknown): ResourceId { /* delegates to parseResourceId */ }
```

(`assertResourceId` is a hypothetical example, not an existing export.)

Keep the old export working (ideally delegating to the new one), test both, and document the replacement.

### 5. Moving or renaming modules

1. Move the file within `src/` and its test within `tests/` to the mirrored path (`src/a/b.ts` ↔ `tests/a/b.test.ts`).
2. Update every `@/` import in `src/` and `tests/`. Do not switch to relative imports (`path-alias/no-relative`).
3. Update `src/index.ts` re-exports so the public names stay the same.
4. Check for module cycles introduced by the move: `pnpm boundaries:check`.
5. Run `pnpm lint:fix` to re-sort imports.

### 6. Moving code between packages

1. Confirm the target package may hold it and that every consumer may depend on the target (see the dependency table in `repository-boundaries` rule).
2. Add `workspace:*` dependencies where needed; remove ones no longer used.
3. If the source package must keep exporting the symbol for compatibility, re-export it from the new home and deprecate the old path.
4. Never import across packages via `src/` or `dist/` paths.
5. Update `examples/package-smoke`, `docs/reference/packages.md`, and `docs/architecture/package-boundaries.md`.

### 7. Adding or renaming packages

- Add new framework packages to `allowedDependencies` in `scripts/check-boundaries.ts`, ESLint restrictions if runtime-neutral, and the smoke example.
- Renaming a package name is a breaking change for consumers; avoid it once a name is documented.
- Run `pnpm install` after manifest changes so `pnpm-lock.yaml` and workspace links update.

### 8. Validate

```bash
pnpm lint:fix
pnpm boundaries:check
pnpm turbo run build typecheck test --filter=...<changed-package>
pnpm check
```

Keep existing tests passing without modification wherever behavior is meant to be preserved; if a test must change, explain why.

## Example

Moving `formatDiagnostic` into `src/diagnostics/format.ts`:

- Create `format.ts`; move the function and its private helper `formatLocation` into it, importing types with `import type { Diagnostic, DiagnosticLocation } from "@/diagnostics/diagnostic";` (multiline, since it has two specifiers).
- Update `src/index.ts`: `export { createDiagnostic } from "@/diagnostics/diagnostic";` and `export { formatDiagnostic } from "@/diagnostics/format";`.
- Move the corresponding tests to `tests/diagnostics/format.test.ts`.
- Public API unchanged → no SemVer impact; state that in the summary.

## Verification checklist

- [ ] Change is limited to the task; no unrelated edits.
- [ ] Public surface affected is listed with SemVer impact and migration path.
- [ ] Removed APIs were deprecated first, or the break is explicitly approved and documented.
- [ ] `@/` imports and `index.ts` re-exports updated; tests mirror the new paths.
- [ ] `pnpm boundaries:check` passes (no cycles, allowed directions, declared deps).
- [ ] `pnpm check` passes, including `examples/package-smoke`; real output reported.
- [ ] Docs and changeset updated for user-visible changes.

## References

- Semantic Versioning: https://semver.org
- Local: [docs/architecture/package-boundaries.md](../../../docs/architecture/package-boundaries.md), [docs/reference/packages.md](../../../docs/reference/packages.md), [scripts/check-boundaries.ts](../../../scripts/check-boundaries.ts), [ADR 0011](../../../docs/architecture/decisions/0011-path-aliases-in-library-packages.md)
- Related skills: `typescript-library`, `release-management`, `holqa-architecture`
