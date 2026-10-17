# Packages

> **Status:** Reference for the current repository state. Three framework packages and one example package exist; all are `"private": true` and unpublished. Other packages are planned.

All packages use the `@holqa/` npm scope, are ESM-only, ship bundled `.d.ts` declarations, and expose a single entry point (`.`) through their `exports` map. Allowed dependencies are listed in [package boundaries](../architecture/package-boundaries.md).

## Summary

| Package | Path | Status | Purpose |
| --- | --- | --- | --- |
| `@holqa/core` | `packages/core` | **Implemented** (foundations) | Framework-neutral contracts and primitives. |
| `@holqa/compiler` | `packages/compiler` | **Implemented** (canonical JSON only) | Compiler; today only deterministic serialization. |
| `@holqa/cli` | `packages/cli` | **Implemented** (help, version, `--json`) | The `holqa` command-line interface. |
| `@holqa/example-package-smoke` | `examples/package-smoke` | **Implemented** | Verifies built package outputs. |
| `@holqa/sdk` | `packages/sdk` | Planned | Public developer-facing SDK. |
| `@holqa/runtime-bun` | `packages/runtime-bun` | Planned | Bun execution and invocation adapters. |
| `@holqa/local` | `packages/local` | Planned | Local execution and resource emulation. |
| `@holqa/testing` | `packages/testing` | Planned | Testing utilities and deterministic execution. |
| `@holqa/client` | `packages/client` | Planned | Browser-safe generated-client runtime. |
| Zod integration | `packages/integrations/zod` | Planned | Zod schema adapter. |
| Valibot integration | `packages/integrations/valibot` | Planned | Valibot schema adapter. |
| Effect integration | `packages/integrations/effect` | Planned | Effect handlers, Effect Schema, Effect HTTP. |
| oRPC integration | `packages/integrations/orpc` | Planned | oRPC interoperability. |
| TanStack Query integration | `packages/integrations/tanstack-query` | Planned | Typed query/mutation options and keys. |

Planned packages are directories containing only a README. They have no `package.json`, so they are not workspace packages. Final npm names for integration packages are not decided.

## `@holqa/core`

- **Path:** `packages/core`
- **Status:** Implemented (foundations). Private.
- **Purpose:** Framework-neutral contracts and primitives shared by every other package. Imports nothing from Bun, Node, or other Holqa packages.
- **Entry point:** `@holqa/core` → `dist/index.js`, `dist/index.d.ts`.
- **Internal dependencies:** none.

| Export | Kind | Description |
| --- | --- | --- |
| `Result<T, E>`, `Ok<T>`, `Err<E>` | Types | Discriminated union for recoverable failures: `{ ok: true, value }` or `{ ok: false, error }`. |
| `ok(value)`, `err(error)` | Functions | Create frozen `Ok` / `Err` results. |
| `Diagnostic` | Type | `{ code, severity, message, location?, hint? }`. |
| `DiagnosticSeverity` | Type | `"error" \| "warning" \| "info"`. |
| `DiagnosticLocation` | Type | `{ file, line?, column? }`, 1-based. |
| `createDiagnostic(input)` | Function | Creates a frozen diagnostic, omitting absent optional fields. |
| `formatDiagnostic(diagnostic)` | Function | Renders `file:line:col severity CODE: message`, plus `\n  hint: …` when present. |
| `diagnosticCodes` | Constant | Registry of every emitted code. See [diagnostic codes](diagnostic-codes.md). |
| `DiagnosticCode` | Type | Union of registered code strings. |
| `ResourceId` | Type | Branded string for validated identifiers. |
| `parseResourceId(value)` | Function | Validates `unknown` input; returns `Result<ResourceId, Diagnostic>`. Never throws. |
| `isResourceId(value)` | Function | Type guard equivalent to `parseResourceId(value).ok`. |
| `maxResourceIdLength` | Constant | `63`. |

Resource identifier grammar: `^[a-z][a-z0-9]*(?:[-.][a-z0-9]+)*$`, 1–63 characters (for example `order-processing`, `orders.process`). The grammar is an initial proposal and may be revised before 1.0 ([ADR 0004](../architecture/decisions/0004-stable-logical-resource-identities.md)).

## `@holqa/compiler`

- **Path:** `packages/compiler`
- **Status:** Implemented (canonical JSON only). Private. The compilation pipeline and manifest schema are planned ([compiler](../architecture/compiler.md)).
- **Purpose:** Resource analysis, manifest IR, diagnostics, and compilation.
- **Entry point:** `@holqa/compiler` → `dist/index.js`, `dist/index.d.ts`.
- **Internal dependencies:** `@holqa/core`.

| Export | Kind | Description |
| --- | --- | --- |
| `canonicalJsonStringify(value)` | Function | Deterministic JSON: sorted keys at every depth, 2-space indent, no trailing newline, `-0` → `0`. Throws `CanonicalJsonError` for values with no canonical form. |
| `CanonicalJsonError` | Class | Error with a `diagnostic` property (code `HOLQA_MANIFEST_NOT_SERIALIZABLE`); the message includes the JSON path, such as `$.resources[0].id`. |
| `CanonicalJsonValue` | Type | `null`, boolean, number, string, arrays, and plain objects of these. |

Rejected values: `undefined`, functions, symbols, bigints, `NaN`, `Infinity`, non-plain objects (such as `Date`, `Map`, class instances), and circular references.

## `@holqa/cli`

- **Path:** `packages/cli`
- **Status:** Implemented (help, version, `--json`). Private. Workflow commands are proposed. See [CLI reference](cli.md).
- **Purpose:** Holqa developer CLI.
- **Entry points:** library `@holqa/cli` → `dist/index.js`; binary `holqa` → `dist/bin.js` (runs on Bun, `engines.bun >= 1.3.13`).
- **Internal dependencies:** `@holqa/core`. Allowed in future: `@holqa/compiler`, `@holqa/local`, `@holqa/runtime-bun`.

| Export | Kind | Description |
| --- | --- | --- |
| `runCli(argv, io, version)` | Function | Runs the CLI against split arguments; writes through `io`; returns an exit code. No other side effects. |
| `CliIo` | Type | `{ stdout(text), stderr(text) }`. |
| `exitCodes` | Constant | `{ success: 0, failure: 1, usage: 2 }`. |
| `proposedCommands` | Constant | The list of proposed commands with one-line summaries. |
| `ProposedCommand` | Type | `{ name, summary }`. |
| `findProposedCommand(positionals)` | Function | Finds the longest proposed command matching the leading positional arguments. |

## `@holqa/example-package-smoke`

- **Path:** `examples/package-smoke`
- **Status:** Implemented. Private; not published.
- **Purpose:** Consumes `@holqa/core`, `@holqa/compiler`, and `@holqa/cli` through their public exports after they are built. It verifies that `dist/` contains JavaScript and declarations, that no unresolved `@/` aliases remain in emitted `.js` or `.d.ts` files, and that the built `holqa` binary runs.
- **Run:** `pnpm --filter @holqa/example-package-smoke test` (after `pnpm build`), or as part of `pnpm test` / `pnpm check`.

## Planned packages

| Package | Intended responsibility | Allowed internal dependencies |
| --- | --- | --- |
| `@holqa/sdk` | `defineApp`, resource factories, typed handles, handler registration. Runtime-neutral. | `core` |
| `@holqa/runtime-bun` | Execute handlers on Bun; HTTP via the Fetch API; invocation adapters; concurrency limits. | `core` |
| `@holqa/local` | Local runtime drivers: queue, storage, and scheduler emulation; event inspection. | `core`, `runtime-bun` |
| `@holqa/testing` | Deterministic test harness; simulated deliveries, retries, failures; fixtures. | `core`, `sdk`, `local`, `runtime-bun` |
| `@holqa/client` | Fetch-based runtime for generated, browser-safe clients. Runtime-neutral. | `core` |
| `packages/integrations/*` | Schema, handler, transport, and client adapters. See [integrations](../integrations/index.md). | `core`, `sdk`, `client` |

See the [roadmap](../roadmap.md) for when each is expected.

## Related

- [Package boundaries](../architecture/package-boundaries.md)
- [Architecture overview](../architecture/overview.md)
- [Releasing](../contributing/releasing.md)
