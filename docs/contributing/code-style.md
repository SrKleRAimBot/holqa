# Code style

Conventions for all TypeScript in this repository. Most of them are enforced by `pnpm lint`, `pnpm typecheck` and `pnpm boundaries:check`. The rest are checked in review. The reasons behind them are in [ADR 0009](../architecture/decisions/0009-test-placement-and-typescript-standards.md).

## Engineering conventions

- **Small, cohesive modules.** One concept per file. `src/index.ts` re-exports the public API and contains no logic.
- **Named exports** for reusable APIs. Use default exports only where a framework contract requires them, such as `tsdown.config.ts`.
- **Minimal runtime dependencies.** Every runtime dependency of a library becomes a dependency of its users. Prefer the platform or a few lines of code over a package.
- **No circular imports**, between packages or between modules within a package. `pnpm boundaries:check` detects both.
- **Composition over inheritance.** Prefer functions and plain data. Use classes only where identity or `instanceof` is the point, as with `CanonicalJsonError`.
- **Explicit contracts over magic.** No uncontrolled reflection, no behaviour driven by property-name conventions, no hidden global mutable state.
- **Backward compatibility by design.** Treat every export, its type and its error behaviour as a contract. Diagnostic codes are never renamed or reused.
- **Meaningful, stable identifiers**, both in code and for Holqa resources (see [ADR 0004](../architecture/decisions/0004-stable-logical-resource-identities.md)).
- **Validate untrusted data at boundaries.** Accept `unknown`, narrow, then return a typed value or a diagnostic, as `parseResourceId` does.
- **Structured errors.** Return `Result<T, Diagnostic>` for expected failures, and throw typed errors carrying a `diagnostic` for programmer errors or unrecoverable states. Use codes from `diagnosticCodes`.
- **Never swallow errors silently.** A `catch` either handles the error meaningfully, rethrows it, or converts it into a diagnostic.
- **No premature abstraction.** Do not add extension points, options or generics before there is a second real use.
- **Explain non-obvious decisions** in a comment or an ADR. Explain *why*, not *what*.
- **Generated code is generated.** It lives in `src/generated/` (ignored by ESLint) and is regenerated, never edited by hand.
- **Never hardcode credentials** or commit real `.env` files.
- **Keep provider-specific logic out of core packages.** Framework-neutral packages (`core`, `compiler`, `sdk`, `client`) must not import `bun`, `bun:*` or `node:*`, and nothing provider-specific belongs there.

## TypeScript

The compiler options come from [`tsconfig.base.json`](../../tsconfig.base.json): `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `noImplicitReturns`, `noFallthroughCasesInSwitch`, `useUnknownInCatchVariables`, `noPropertyAccessFromIndexSignature`, `noUnused*`, `verbatimModuleSyntax` and `isolatedModules`.

- **No `any`** unless it is unavoidable, and then with a comment explaining why. Use `unknown` and narrow it.
- **Discriminated unions** for protocol and state types, rather than objects full of optional properties. `Result<T, E>` (`{ ok: true; value } | { ok: false; error }`) is the model.
- **Optional properties:** under `exactOptionalPropertyTypes`, `prop?: T` does not accept `undefined`. Omit the property with a conditional spread, `...(hint === undefined ? {} : { hint })`, or declare `prop?: T | undefined` if `undefined` is meaningful.
- **Index access** returns `T | undefined`. Handle the `undefined` case, and do not use `!` to get rid of it.
- **Explicit return types** on functions are required. antfu's `lib` mode enables `ts/explicit-function-return-type`, with expressions, higher-order functions and IIFEs allowed.
- **Type-only imports** are separate statements: `import type { Diagnostic } from "@/diagnostics/diagnostic";` (`ts/consistent-type-imports` with `separate-type-imports`).
- **Interfaces for object shapes** (`ts/consistent-type-definitions: interface`). Use `type` for unions, mapped types and aliases.
- **Do not suppress errors to pass checks.** `@ts-expect-error` is used only in tests, for intentional negative type tests, and must carry a description (`ts/ban-ts-comment`), for example `// @ts-expect-error A plain string is not a validated ResourceId.`. `@ts-ignore` is not allowed.
- **Branded types** for validated values (`ResourceId`). Construct them only through the validating function.

## Formatting and imports

Enforced by ESLint (`pnpm lint:fix` fixes most of them):

| Convention | Rule |
| --- | --- |
| Double quotes; template literals allowed | `style/quotes` |
| Semicolons | `style/semi` |
| 2-space indent | `style/indent` |
| No trailing commas | `style/comma-dangle: never` |
| 1TBS braces, no single-line blocks | `style/brace-style` |
| Braces only around multi-line or nested bodies, consistent across `if`/`else` | `curly: multi-or-nest, consistent` |
| Sorted imports, type imports grouped first | `perfectionist/sort-imports` |
| Imports with 2 or more specifiers span multiple lines | `style/object-curly-newline` |
| `@/` instead of relative imports inside a package | `path-alias/no-relative` |
| Use global `process` and `Buffer`, never import them | `node/prefer-global/process`, `node/prefer-global/buffer` |
| Code files do not end with a newline; JSON, YAML and Markdown do | `style/eol-last` (code only), `.editorconfig` |

```typescript
import type { Diagnostic } from "@/diagnostics/diagnostic";

import { diagnosticCodes } from "@/diagnostics/codes";
import {
  err,
  ok
} from "@/result";

if (value === null)
  return "null";
```

## Documentation comments

Every named function, method and class, every named arrow function or function expression (`const parse = () => ...`), and every exported interface, type alias and constant needs a documentation comment. The style follows C# XML documentation summaries, written as TSDoc:

- A **summary** that says what the code does and why it exists, not a restatement of its name.
- `@param name - description` for each parameter.
- `@returns description` for non-`void` functions.
- `@throws {ErrorType} When ...` for errors a caller can observe.
- `@example` with a fenced code block when usage is not obvious from the signature.
- Invariants, side effects, failure behaviour and architectural constraints for complex functions.
- **No JSDoc types** (`@param {string} name`). TypeScript already has them.

Good:

```typescript
/**
 * Validates an untrusted value against the resource identifier grammar.
 *
 * This function never throws: invalid input produces an error diagnostic with
 * the code `HOLQA_RESOURCE_ID_INVALID`.
 *
 * @param value - The untrusted candidate identifier.
 * @returns The branded identifier, or a diagnostic describing why it is invalid.
 *
 * @example
 * ```ts
 * const result = parseResourceId("order-processing");
 * ```
 */
export function parseResourceId(value: unknown): Result<ResourceId, Diagnostic> {
```

Bad:

```typescript
/**
 * Parse resource id.
 *
 * @param {unknown} value - The value.
 * @returns The result.
 */
export function parseResourceId(value: unknown): Result<ResourceId, Diagnostic> {
```

The bad example restates the name, uses a JSDoc type, and has parameter and return descriptions that add nothing.

**Exempt:** short anonymous inline callbacks, such as `files.filter(file => file.endsWith(".js"))` or `describe`/`it` bodies in tests. The surrounding documented function covers them. This exemption does not extend to named helpers: a nested `function visit(node)` still needs a comment. `.d.ts` files and `tsdown.config.ts` are excluded from the rules.

### What the linter enforces

These rules apply to `**/*.{ts,tsx,mts,cts}` and come from `eslint-plugin-jsdoc`, which `@antfu/eslint-config` includes:

| Rule | Enforces |
| --- | --- |
| `jsdoc/require-jsdoc` | A comment exists on function declarations, methods (including constructors, getters and setters), classes, `VariableDeclarator > ArrowFunctionExpression/FunctionExpression`, and exported interfaces, type aliases and `const`s. `enableFixer: false`: the linter never inserts empty stubs. |
| `jsdoc/require-description` | Functions, methods, classes and named function expressions have a summary, not only tags. |
| `jsdoc/require-param`, `jsdoc/require-param-description` | Every parameter is documented with a description. Destructured parameters are not checked individually. |
| `jsdoc/require-returns`, `jsdoc/require-returns-description` | Non-`void` functions document their return value. |
| `jsdoc/no-types`, with `require-param-type` and `require-returns-type` off | No redundant JSDoc types. |
| `jsdoc/informative-docs` | Rejects descriptions that only repeat the name, for example "Parse resource id." on `parseResourceId`. |
| `jsdoc/tag-lines` | A blank line between the summary and the tags. |

The linter can check that documentation exists and that it is not just the name. It cannot check that it is accurate or useful. Reviewers reject summaries written only to satisfy the rule.

## ESLint overview

There is one flat config, [`eslint.config.mjs`](../../eslint.config.mjs), shared by every package. Packages run `eslint .` from their own directory, and `pnpm lint:repo` covers the root. The config is layered:

1. `antfu({ type: "lib", formatters: true, stylistic: { indent: 2, semi: true, quotes: "double" }, ... })`: TypeScript, stylistic, import sorting, JSON, YAML, pnpm and JSDoc presets. Overrides: `ts/consistent-type-imports` (separate type imports) and `ts/no-empty-object-type` off.
2. Ignores: `dist`, `node_modules`, `coverage`, `build`, `.output`, `.tanstack`, `.vite`, `.turbo`, `*.css`, `*.html`, `*.md`, `src/routeTree.gen.ts`, `src/generated/**`, `LICENSE`.
3. The maintainer's stylistic overrides (see [formatting and imports](#formatting-and-imports)), `no-undef` off (TypeScript handles it), `path-alias/no-relative`, and `no-restricted-imports` against deep imports into another package's `src/` or `dist/`.
4. `style/eol-last: never` for code files only.
5. JSDoc enforcement (see [above](#what-the-linter-enforces)).
6. `no-restricted-syntax` that rejects any `*.test.ts` or `*.spec.ts` under `src/`.
7. Architecture restrictions: framework-neutral packages cannot import `bun`, `bun:*`, `node:*` or runtime, tooling and testing packages. `core` cannot import any `@holqa/*` package. `sdk` and `client` cannot import `@holqa/compiler`.
8. `no-console` off for `scripts/**`, `tsdown.config.ts` and `eslint.config.mjs`.

Run `pnpm lint:fix` before committing. If a rule seems wrong for a case, raise it in the pull request rather than adding an inline `eslint-disable`. Any disable needs a comment that explains why.

## ESLint compatibility notes

The configuration reproduces the maintainer's preferred `@antfu/eslint-config` baseline as closely as the installed versions allow (ESLint 10.12, `@antfu/eslint-config` 9.5, TypeScript 6.0). These are the deliberate deviations:

1. **`type: "lib"` instead of `"app"`.** Holqa's packages are published libraries. `lib` mode enables antfu's library rules, most notably `ts/explicit-function-return-type`, so public signatures stay explicit and stable rather than inferred from implementation details.

2. **React plugins and rule overrides are omitted.** `eslint-plugin-react-hooks`, `eslint-plugin-react-hooks-extra`, and the `react/*` and `react-refresh/*` overrides are not included. The repository has no React code. antfu's React integration is not enabled, so those rule names would be undefined, and ESLint errors on unknown rules. `eslint-plugin-react-hooks-extra`'s peer range also excludes TypeScript 6. When a React package or example is added, enable `react: true` in the antfu options and restore the overrides.

3. **`eslint-plugin-n` is registered under `n`, and the rules are written `node/*`.** The plugin is registered as `n` as requested. antfu already registers the same plugin under the `node` prefix, which is why the rules are `node/prefer-global/process` and `node/prefer-global/buffer`.

4. **`style/eol-last: never` applies to code files only.** JSON, YAML and Markdown keep a final newline, because pnpm (`package.json`, `pnpm-workspace.yaml`), Changesets and other tools rewrite those files with one. Forbidding it there would make the tools and the linter fight. [`.editorconfig`](../../.editorconfig) mirrors the split (`insert_final_newline = false` for `*.{ts,tsx,mts,cts,js,mjs,cjs}`), so editors and the linter agree.

5. **`eslint-plugin-path-alias` peer range override.** The plugin (v2) declares an `eslint@^8` peer dependency. It only uses `context.filename`-style APIs that still exist in ESLint 10, so [`pnpm-workspace.yaml`](../../pnpm-workspace.yaml) has a narrow `peerDependencyRules.allowedVersions` entry (`eslint-plugin-path-alias>eslint: "10"`) instead of a global relaxation. The plugin reads each package's tsconfig `paths`. Files whose tsconfig has no `paths` (root `scripts/`, examples) are unaffected by `path-alias/no-relative`.

6. **Additions:**
   - JSDoc enforcement for the [documentation-comment requirement](#documentation-comments), with `enableFixer: false` so the linter never inserts empty stubs.
   - Holqa architecture rules with `no-restricted-imports` (runtime neutrality, compiler isolation from `sdk` and `client`, no deep imports), replacing the application-specific import restrictions of the original config.
   - `**/.turbo/**` (and `LICENSE`) added to the ignore list.
   - `no-console` off for `scripts/**`, `tsdown.config.ts` and `eslint.config.mjs`, which run as programs.

7. **pnpm rules from antfu.** antfu's pnpm integration lints `package.json` and `pnpm-workspace.yaml`. It requires shared dependency versions to use catalogs (`"catalog:"`) and expects the settings `trustPolicy: no-downgrade`, `shellEmulator: true` and `minimumReleaseAgeExcludePrune: true` in `pnpm-workspace.yaml`, all of which are present.

8. **`formatters: true` is kept, but has nothing to format yet.** antfu's formatters handle CSS, HTML and Markdown, and the requested ignore list excludes `**/*.css`, `**/*.html` and `**/*.md`. The option is kept to match the baseline and becomes active if the ignores change.

9. **TypeScript 6.0 instead of 7.** typescript-eslint 8.x supports `typescript <6.1`, and TypeScript 7 does not expose the classic JavaScript API that typescript-eslint and tsdown's declaration emit rely on. See [ADR 0010](../architecture/decisions/0010-typescript-6-until-tooling-supports-7.md).
