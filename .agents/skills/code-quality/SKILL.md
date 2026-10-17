---
name: code-quality
description: Holqa's code-quality conventions and how to satisfy them - the single root ESLint flat config built on @antfu/eslint-config, its key style and architecture rules, the mandatory JSDoc function-summary requirement with good and bad examples, autofixing with pnpm lint:fix, and the policy against disabling rules to pass. Use when writing or reviewing any TypeScript or JavaScript in the repository, when ESLint or JSDoc errors appear, or before declaring a code change complete.
---

# Code quality

## Purpose

Every source file in the repository is linted by one shared configuration, [`eslint.config.mjs`](../../../eslint.config.mjs). This skill explains what it enforces, how to write documentation comments that pass `jsdoc/*` rules meaningfully, and how to run and fix lint.

## When to use

- Writing or editing any `.ts`, `.mts`, `.js`, or `.mjs` file.
- Fixing ESLint failures from `pnpm lint` or `pnpm check`.
- Reviewing code for convention and documentation quality.

## Commands

```bash
pnpm lint                                   # turbo: every package's `eslint .` plus //#lint:repo
pnpm lint:fix                               # eslint . --fix across the whole repo (uncached)
pnpm --filter @holqa/core lint:fix          # one package
pnpm exec eslint packages/core/src/result.ts --fix   # one file
```

Markdown, CSS, and HTML are ignored by ESLint. JSON and YAML are linted.

## Key conventions

| Area | Rule |
| --- | --- |
| Base | `antfu({ type: "lib", formatters: true })`, 2-space indent, double quotes, semicolons |
| Commas | No trailing commas (`style/comma-dangle: never`) |
| Braces | 1tbs, no single-line blocks; `curly: multi-or-nest, consistent` |
| End of file | `.ts`/`.js` files have **no** trailing newline; JSON, YAML, Markdown keep one |
| Imports | Sorted (`perfectionist/sort-imports`); `import type` in separate statements first; multiline when importing 2+ specifiers |
| Exports | Multiline when exporting 3+ specifiers |
| Aliases | `@/` instead of relative paths inside a package (`path-alias/no-relative`) |
| Node globals | Use global `process`/`Buffer` (`node/prefer-global/*: always`) |
| Tests | `*.test.ts` / `*.spec.ts` under `src/` are errors; tests go in `tests/` |
| Architecture | `no-restricted-imports` blocks deep imports into other packages and runtime/tooling imports from neutral packages |
| Docs | `jsdoc/require-jsdoc` and related rules (below) |

Full rule notes: [references/eslint-rules.md](references/eslint-rules.md).

### `curly: multi-or-nest, consistent` in practice

```ts
// Single-line body: no braces.
if (value === null)
  return "null";

// Body spans multiple lines: braces required.
if (!resourceIdPattern.test(value)) {
  return err(invalidResourceId(
    `Resource identifier "${value}" is invalid.`,
    "Use lowercase letters and digits, ..."
  ));
}
```

## JSDoc summary requirement

Every function declaration, method, class, constructor, getter/setter, named arrow function or function expression (`const f = () => {}`), and every exported interface, type alias, and `const` must have a JSDoc comment. Functions and methods need a description, `@param` with a description for each parameter, and `@returns` with a description. `jsdoc/informative-docs` rejects summaries that only restate the name. Type annotations in JSDoc are forbidden (`jsdoc/no-types`); TypeScript provides them. The fixer is disabled on purpose: write each summary yourself.

Public APIs should also document `@throws`, side effects, invariants, and an `@example` when usage is not obvious.

**Bad** (fails `informative-docs` or adds nothing):

```ts
/**
 * Parse resource id.
 *
 * @param value - The value.
 * @returns The result.
 */
export function parseResourceId(value: unknown): Result<ResourceId, Diagnostic> { /* ... */ }
```

**Good** (states behavior, contract, and failure mode):

```ts
/**
 * Validates an untrusted value against the resource identifier grammar.
 *
 * This function never throws: invalid input produces an error diagnostic with
 * the code `HOLQA_RESOURCE_ID_INVALID`.
 *
 * @param value - The untrusted candidate identifier.
 * @returns The branded identifier, or a diagnostic describing why it is invalid.
 */
```

Short inline callbacks (`items.map(item => item.id)`) do not need comments. Named helpers, including test helpers, do.

## Policy

- Never add `eslint-disable` comments, edit `eslint.config.mjs`, or add ignore patterns to make lint pass. Fix the code.
- If a rule is genuinely wrong for a file category, propose a narrow, commented config exception in a separate change and document it in [docs/contributing/code-style.md](../../../docs/contributing/code-style.md).
- Do not write meaningless summaries to satisfy `require-jsdoc`.
- Run `pnpm lint:fix` before manual fixing; it handles import order, spacing, commas, and end-of-file newlines.

## General conventions

- Small, cohesive modules; named exports; composition over inheritance.
- No hidden global mutable state; no circular imports (`pnpm boundaries:check` detects them).
- Explicit contracts, structured errors with diagnostic codes, no silently swallowed errors.
- Generated files are not hand-edited; `**/src/generated/**` is ignored by ESLint for that reason.
- No hardcoded credentials.

## Verification checklist

- [ ] `pnpm lint` passes with no new `eslint-disable` comments or config changes.
- [ ] Every new named function, method, class, and exported type/const has an informative JSDoc summary with `@param`/`@returns` descriptions.
- [ ] Public functions document `@throws` where applicable.
- [ ] New `.ts` files end without a trailing newline; Markdown/JSON/YAML end with one.
- [ ] Imports use `@/` within a package and package names across packages.
- [ ] `pnpm typecheck` passes.

## References

- ESLint flat config: https://eslint.org/docs/latest/use/configure/configuration-files
- @antfu/eslint-config: https://github.com/antfu/eslint-config
- eslint-plugin-jsdoc: https://github.com/gajus/eslint-plugin-jsdoc
- TSDoc: https://tsdoc.org
- Local: [docs/contributing/code-style.md](../../../docs/contributing/code-style.md), [eslint.config.mjs](../../../eslint.config.mjs), [references/eslint-rules.md](references/eslint-rules.md)
- Related skills: `typescript-library`, `testing`
