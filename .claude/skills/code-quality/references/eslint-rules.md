# ESLint rule notes

This file explains the non-obvious parts of [`eslint.config.mjs`](../../../../eslint.config.mjs). The config file itself is authoritative; if they disagree, trust the config and fix this file.

## Configuration blocks, in order

| Block | Files | Purpose |
| --- | --- | --- |
| `antfu({...})` | all | Base: `type: "lib"`, formatters, stylistic (2 spaces, semicolons, double quotes), `ts/consistent-type-imports` with separate type imports, `ts/no-empty-object-type` off, plugins `n` and `path-alias` |
| Ignores | all | `dist`, `node_modules`, `coverage`, `build`, `.output`, `.tanstack`, `.vite`, `.turbo`, `*.css`, `*.html`, `*.md`, generated route trees and `src/generated/**`, `LICENSE` |
| Style overrides | all | Maintainer's preferred style rules, `perfectionist/sort-imports`, `path-alias/no-relative`, no deep package imports |
| End of line | `**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}` | `style/eol-last: never` |
| JSDoc | `**/*.{ts,tsx,mts,cts}` except `*.d.ts` and `tsdown.config.ts` | Function-summary requirement |
| Tests in `src/` | `**/src/**/*.{test,spec}.{ts,tsx}` | Whole-file error |
| Neutral packages | `packages/{core,compiler,sdk,client}/src/**` | No `bun`, `bun:*`, `node:*`, runtime/tooling/testing packages |
| Core | `packages/core/src/**` | No `@holqa/*` imports at all |
| SDK and client | `packages/{sdk,client}/src/**` | Additionally no `@holqa/compiler` |
| Programs | `scripts/**`, `**/tsdown.config.ts`, `eslint.config.mjs` | `no-console` off |

Later blocks that set `no-restricted-imports` replace earlier settings for matching files, which is why each block repeats the deep-import pattern it needs.

## Rules that surprise people

| Rule | Effect | Fix |
| --- | --- | --- |
| `style/eol-last: never` | Code files must not end with `\n` | `pnpm lint:fix`; configure the editor via `.editorconfig` (already set) |
| `style/object-curly-newline` | `import { a, b }` must be multiline; exports need 3+ to require it | `pnpm lint:fix` |
| `perfectionist/sort-imports` | Groups: type imports, then external/builtin, then `@/` internal | `pnpm lint:fix` |
| `curly: multi-or-nest, consistent` | No braces around single-line bodies; braces when the body spans lines; consistent across `if`/`else` | Restructure or let `--fix` apply |
| `style/brace-style: 1tbs, allowSingleLine: false` | `{ return x; }` on one line is an error | Expand the block |
| `path-alias/no-relative` | `./foo` and `../foo` are errors inside packages | Use `@/foo` |
| `node/prefer-global/process` | `import process from "node:process"` is an error | Use the global |
| `jsdoc/require-jsdoc` (`enableFixer: false`) | Missing docs are reported, never stubbed | Write a real summary |
| `jsdoc/informative-docs` | "Gets the name." on `getName` fails | Describe behavior, constraints, failure modes |
| `jsdoc/no-types` | `@param {string} name` fails | Drop the `{type}` |
| `jsdoc/tag-lines` | One blank line between the description and the first tag | Add the blank line |
| `jsdoc/require-param` with `checkDestructured: false` | Destructured parameter members need no individual `@param` | Document the whole parameter |

## Documented compatibility adjustments

The maintainer's baseline targeted an application (`type: "app"`, React plugins). For this library monorepo the config uses `type: "lib"`, drops React-specific plugins and rules, scopes `eol-last: never` to code files so JSON/YAML/Markdown written by tools keep their newline, and adds Holqa-specific architecture restrictions. See [docs/contributing/code-style.md](../../../../docs/contributing/code-style.md#eslint-compatibility-notes).
