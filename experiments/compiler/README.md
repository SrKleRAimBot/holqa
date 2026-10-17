# Deterministic compilation experiment

> **Status:** Disposable M0 experiment — not part of the framework.

## Question

Can resource definitions and handler metadata be extracted into a stable, portable manifest, including reasonable support for imported schemas?

**Answer: yes, by evaluating the application's modules, with three limitations that must be designed for rather than solved.** Compilation runs user code. Static analysis cannot recover schemas. Fingerprints depend on the schema library and its version.

## Method

| Piece | Where | Runtime |
| --- | --- | --- |
| Manifest IR (`manifestVersion: 0`) | `src/manifest.ts` | Neutral |
| `compileApp({ app, modules, adapters })`: graph validation, schema conversion, fingerprints | `src/compile.ts`, `src/schemas/`, `src/graph/` | Neutral (no `bun`, `bun:*`, `node:*`) |
| `serializeManifest` (canonical JSON from `@holqa/compiler`) | `src/serialize.ts` | Neutral |
| `moduleEvaluationFailure` (turns a host's caught error into a diagnostic) | `src/diagnostics.ts` | Neutral |
| Bun host: glob discovery, `import()` of `infra.ts` and handlers, prints the manifest | `tests/support/load-and-compile.ts` | Bun |
| Fixture applications (`commerce`, `top-level-config`) | `tests/fixtures/` | Bun + Zod |

The split is intentional. The compiler never loads code. A host (later the CLI, which may depend on `compiler` and `runtime-bun`) evaluates modules and passes in descriptors and root-relative module paths. The compiler reads only the model's `~holqa` descriptor protocol and the `SchemaAdapter` contract. It never imports the SDK or a schema library. Tests use the real Zod adapter from `@holqa/experiment-schema-adapters` (`zodAdapter`) plus hand-made Standard Schemas for vendor-neutral paths.

### Manifest shape

- `app`: name and handler globs.
- `resources`: sorted by id. Each has kind, config and schema uses by role.
- `handlers`: sorted by id, then module. Each has trigger, config, root-relative module path with `/` separators, sorted export names, and schema uses.
- `configuration`: sorted by name. Each has name, `sensitive` and schema use. A `default` appears only for non-sensitive variables. Values are never recorded, and a secret that declares a default is an error.
- `schemas`: a table keyed by fingerprint. Each entry holds `{ jsonSchema, runtimeOnly }`. A schema use is `{ input, output, converter, fidelity }`, and a `null` fingerprint marks a side that cannot be represented.

### Normalization and fingerprints

- `$schema` is removed at every depth.
- Set-like keywords (`required`, and `type` arrays) are sorted and de-duplicated.
- Order-significant or order-ambiguous arrays (`enum`, `prefixItems`, `anyOf`, `oneOf`, `allOf`, `examples`) keep declaration order. This is conservative: reordering an enum reports a change, which can be a false positive but never a missed change.
- Object key order needs no handling because canonical JSON sorts keys.
- Fingerprint: `sha256:` of the canonical JSON of `{ jsonSchema, runtimeOnly }`, computed with `crypto.subtle`, so `compileApp` is async. The runtime-only notes are hashed because JSON Schema cannot see refinements. Without them, `z.string()` and `z.string().refine(...)` would share a fingerprint.
- Wire side: responses are validated output, so the wire side is `output`. Everything else (messages, params, query, body, config) is sent before validation, so the wire side is `input`. A failure on the wire side is an error. A failure on the other side, such as the output of a Zod transform, is a warning, and the manifest records `null`.

### Diagnostics (all collected, never first-error-only; deterministically sorted)

| Condition | Code | Severity |
| --- | --- | --- |
| Invalid resource or handler id | `HOLQA_RESOURCE_ID_INVALID` (core) | error |
| Duplicate resource id | `HOLQA_RESOURCE_ID_DUPLICATE` | error |
| Duplicate handler id | `HOLQA_HANDLER_ID_DUPLICATE` | error |
| Trigger references an undeclared resource | `HOLQA_RESOURCE_NOT_FOUND` | error |
| Trigger and resource kind mismatch; absolute or escaping module path; not an app; secret default | `HOLQA_DECLARATION_INVALID` | error |
| Unknown descriptor protocol on an export | `HOLQA_DECLARATION_INVALID` | warning |
| Two consumers for one queue | `HOLQA_QUEUE_CONSUMER_DUPLICATE` | error |
| Same method and path shape after joining `basePath` (`/orders/:id` and `orders/:orderId/`) | `HOLQA_ROUTE_AMBIGUOUS` | error |
| Wire side not representable, or neither an adapter nor Standard JSON Schema | `HOLQA_SCHEMA_UNSUPPORTED` | error |
| Non-wire side not representable; runtime-only constraints | `HOLQA_SCHEMA_UNSUPPORTED` | warning |
| Only the generic Standard JSON Schema converter is available | `HOLQA_SCHEMA_FIDELITY_UNVERIFIED` | warning |
| A module threw during host evaluation | `HOLQA_MODULE_EVALUATION_FAILED` | error |

A static segment and a parameter at the same position (`/orders/new` and `/orders/:id`) are deliberately not reported as ambiguous. That assumes routers prefer the static segment, and every runtime driver must document that precedence.

## Results

All results come from real runs on Bun 1.3.13 with Zod 4.6.7 on macOS.

| Check | Result |
| --- | --- |
| `npx -y pnpm@12.14.0 turbo run build typecheck lint test --filter=@holqa/experiment-compiler` | 9/9 tasks successful; 38 tests pass, 0 fail |
| Byte identity: two copies of the `commerce` fixture at different absolute paths, 5 separate `bun` processes, discovery order shuffled with seeds 1, 7 and 42 | Identical manifests. No absolute path, `.tmp` or `\` in the output |
| In-memory order independence: reversed resource declaration order and reversed module order | Identical serialized manifests |
| Imported schemas: `orderMessage` built from `lineItem`, two modules away from `infra.ts` and re-exported through an index | Fully represented (the `quantity` constraint appears in the queue message schema) |
| A module that exports two handlers | Both extracted, with their export names |
| `z.object({ a, b })` and `z.object({ b, a })` | Same fingerprint |
| `.min(1)` added to a field; `.refine()` added | Different fingerprints |
| `DATABASE_URL=postgres://user:hunter2@…` set in the compiling process | Value absent from the manifest; only the name and schema are recorded |
| Handler module importing a `db.ts` that reads `app.env.DATABASE_URL` at top level | `HOLQA_MODULE_EVALUATION_FAILED` on `src/report.handler.ts`; the message names `HOLQA_RUNTIME_NOT_BOUND`, and the hint says to move access out of module top level |
| Compile time for the `commerce` fixture (5 modules, 6 handlers, 16 schemas, 15,921-byte manifest) | Evaluating `infra.ts` and handlers ≈ 18 ms; `compileApp` + serialize: first call ≈ 5.6 ms, median of 50 ≈ 0.9 ms; whole `bun` loader process ≈ 0.04 s wall |

## Findings

### Fundamental limitations (design around them)

1. **Compiling runs user code.** Extraction works because the host `import()`s `infra.ts` and every handler module, which executes their top-level code and their whole dependency graph. Nothing is sandboxed in this experiment, and nothing should claim compilation is safe on untrusted repositories. The trust model must say: "`holqa build` and `holqa inspect` execute your application's modules, like running its tests." A sandbox (separate process, no network, read-only file system, no secrets in the environment) can reduce the blast radius later, but it is a hardening measure, not a precondition.
2. **Static analysis cannot recover schemas.** The fixture's queue schema is assembled from values imported through two modules. Real code also builds schemas from functions, `.extend()`, shared packages and conditionals. Only evaluating the library's own converter yields its JSON Schema, and only the library (through an adapter) knows what a refinement does. A static reader could at best find identifiers and string literals, such as ids and route paths. It could not produce schemas, fingerprints or runtime-only notes. Evaluation is therefore required for the manifest. Static analysis remains useful only as a fast, partial index for editors and agents.
3. **Fingerprints depend on the schema library and its version.** The manifest stores whatever the library emits after Holqa's light normalization. Zod adds `maximum: 9007199254740991` to every `.int()`, which is present in this fixture's output. Valibot does not, so the same logical schema written in two libraries gets two fingerprints, and a library upgrade that changes its JSON Schema output changes fingerprints without any contract change. The manifest records the converter (`zod adapter (zod@4)`) so such changes are explainable. A compatibility engine must compare normalized structure, not fingerprints alone. Fingerprints are a cheap "maybe changed" signal, not proof of a breaking change.
4. **Module top-level side effects break analysis.** Any module that touches a runtime binding at import time fails to compile. That includes the example's `src/db.ts` pattern (`new SQL(config.DATABASE_URL)`). This is the correct outcome, because the compiler must never invent secret values, and the diagnostic is clear. But it constrains the programming model: configuration and resource handles must be used lazily (inside handlers, or behind a lazily created client). `examples/basic-backend/src/db.ts` would not compile as written.

### Other findings

- **Descriptor identity, not export identity, defines a handler.** The same object exported as `default` and by name, or re-exported by another module, is one handler, attributed to the first module by path. Different objects with the same id are a duplicate.
- **Diagnostics have two code sources.** `@holqa/core`'s `Diagnostic.code` is a closed union, so the compiler mixes core codes (`HOLQA_RESOURCE_ID_INVALID`) with experiment codes through `CompilerDiagnostic = Diagnostic | ExperimentDiagnostic`. The real compiler needs every code registered in core.
- **Runtime-only constraints need their own code.** They are reported as `HOLQA_SCHEMA_UNSUPPORTED` with severity warning. A distinct code (for example `HOLQA_SCHEMA_RUNTIME_ONLY`) would let tools tell "partially portable" from "unrepresentable" without reading severities.
- **Zod objects have two contracts.** For objects, Zod's output side adds `additionalProperties: false` and the input side does not. This accurately reflects that unknown keys are accepted and then stripped, so input and output fingerprints differ for almost every object schema.
- **The SDK's queue round-trip is broken for transforms (an SDK finding).** `queue.send` validates the message and hands the transformed output to the driver, and the consumer validates that value again against the input schema. Verified with `z.iso.datetime().transform(s => new Date(s))`: the in-memory re-validation fails ("expected string, received Date"). It only works after JSON serialization, and only by accident. The wire contract must be the input side, which means sending the encoded input, or requiring explicit codecs for transformed schemas. **Resolved during M0:** the prototype SDK now validates on `send` but forwards the input (encoded) form, and `experiments/sdk/tests/resources/queue.test.ts` covers the in-memory round trip.

## Recommendation

- Keep the compiler neutral and host-driven exactly as prototyped. The CLI (Bun) evaluates modules in a dedicated process and passes `{ app, modules }` to the compiler, and the compiler stays testable in memory.
- Adopt evaluation-based extraction and document the trust assumption in `docs/concepts/security.md` before `holqa build` ships. Run analysis in a child process with an environment stripped of secrets.
- Keep the manifest's `schemas` table keyed by fingerprint with a per-use converter and fidelity. Make the wire side explicit per role, and record both sides.
- Treat the normalization rules above as the starting specification. Version them with `manifestVersion`, because any change to normalization changes every fingerprint.
- Require lazy access to bindings and configuration in the programming model, and fix the `db.ts` pattern in the examples.
- Register the codes used here in `@holqa/core` when the real compiler lands, and add one for runtime-only constraints.

## What is disposable

Everything in this package. Keep the design, not the code: the manifest field names, the normalization list and the diagnostic set are inputs to the real `@holqa/compiler` design, not its implementation.
