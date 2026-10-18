# Packages

> **Status:** Reference for the current repository state. Five framework packages, one integration package and four example packages (`package-smoke`, `schema-evolution` and `manifest` against the framework, `commerce` against the M0 experiments) exist; all are `"private": true` and unpublished. Other packages are planned.

All packages use the `@holqa/` npm scope, are ESM-only, ship bundled `.d.ts` declarations, and expose a single code entry point (`.`) through their `exports` map. `@holqa/compiler` additionally exports its JSON Schema files. Allowed dependencies are listed in [package boundaries](../architecture/package-boundaries.md).

## Summary

| Package | Path | Status | Purpose |
| --- | --- | --- | --- |
| `@holqa/core` | `packages/core` | **Implemented** (contracts) | Framework-neutral contracts: diagnostics, identity, descriptor protocol, resource and trigger registries, runtime binding. |
| `@holqa/compiler` | `packages/compiler` | **Implemented** (manifest pipeline, schema contracts) | Handler discovery, graph validation, manifest version 1, schema contracts and compatibility checks. |
| `@holqa/cli` | `packages/cli` | **Implemented** (help, version, `--json`, `inspect`, `build --manifest`) | The `holqa` command-line interface. |
| `@holqa/example-package-smoke` | `examples/package-smoke` | **Implemented** | Verifies built package outputs. |
| `@holqa/example-schema-evolution` | `examples/schema-evolution` | **Implemented** | End-to-end schema contract corpus with Zod. |
| `@holqa/example-manifest` | `examples/manifest` | **Implemented** | End-to-end compilation of SDK applications through the built CLI. |
| `@holqa/sdk` | `packages/sdk` | **Implemented** (application and resource model) | Public developer-facing SDK. |
| `@holqa/runtime-bun` | `packages/runtime-bun` | Planned | Bun execution and invocation adapters. |
| `@holqa/local` | `packages/local` | Planned | Local execution and resource emulation. |
| `@holqa/testing` | `packages/testing` | **Implemented** (type assertions only) | Testing utilities; deterministic execution is planned. |
| `@holqa/client` | `packages/client` | Planned | Browser-safe generated-client runtime. |
| `@holqa/zod` | `packages/integrations/zod` | **Implemented** | Zod 4 schema adapter. |
| Valibot integration | `packages/integrations/valibot` | Planned | Valibot schema adapter. |
| Effect integration | `packages/integrations/effect` | Planned | Effect handlers, Effect Schema, Effect HTTP. |
| oRPC integration | `packages/integrations/orpc` | Planned | oRPC interoperability. |
| TanStack Query integration | `packages/integrations/tanstack-query` | Planned | Typed query/mutation options and keys. |

Planned packages are directories containing only a README. They have no `package.json`, so they are not workspace packages. Final npm names for integration packages are not decided.

## `@holqa/core`

- **Path:** `packages/core`
- **Status:** Implemented (contracts). Private.
- **Purpose:** Framework-neutral contracts and primitives shared by every other package. Imports nothing from Bun, Node, or other Holqa packages. See [resource model](../architecture/resource-model.md).
- **Entry point:** `@holqa/core` → `dist/index.js`, `dist/index.d.ts`.
- **Internal dependencies:** none.

| Export | Kind | Description |
| --- | --- | --- |
| `Result<T, E>`, `Ok<T>`, `Err<E>` | Types | Discriminated union for recoverable failures: `{ ok: true, value }` or `{ ok: false, error }`. |
| `ok(value)`, `err(error)` | Functions | Create frozen `Ok` / `Err` results. |
| `Diagnostic` | Type | `{ code, severity, message, location?, hint?, details? }`. |
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
| `checkIdentities(identities, scope)` | Function | Reports every invalid (`HOLQA_RESOURCE_ID_INVALID`) and duplicated (`HOLQA_RESOURCE_ID_DUPLICATE`) identifier in a scope at once. |
| `HolqaError` | Class | Error carrying a non-empty `diagnostics` list; `code` is the first diagnostic's code. |
| `failWith(code, message, hint?)` | Function | Throws a `HolqaError` with one error diagnostic. |
| `isHolqaError(value)`, `diagnosticsOf(value)` | Functions | Recognize Holqa errors by shape, including errors from another copy of the package. |
| `JsonValue`, `JsonObject`, `isJsonValue(value)` | Types, function | Plain JSON data and a guard that rejects non-finite numbers, non-plain objects and cycles. |
| `StandardSchemaV1`, `InferInput`, `InferOutput`, `isStandardSchema(value)` | Types, function | Structural copies of the Standard Schema v1 interfaces, and a structural guard. |
| `StandardJsonSchemaV1`, `StandardJsonSchemaConverter`, `StandardJsonSchemaOptions`, `StandardJsonSchemaTarget`, `hasStandardJsonSchema(schema)` | Types, function | Structural copies of the Standard JSON Schema extension, and a guard. |
| `validateInput(schema, value, subject)` | Function | Validates untrusted input (always awaited) and returns the schema output; throws `InputValidationError` (`HOLQA_INPUT_INVALID`). |
| `InputValidationError`, `ValidationIssue`, `ValidationIssueInit`, `ValidationPathSegment`, `normalizeIssue(issue)` | Class, types, function | Per-field issues with `path`, `segments`, `pointer` and scalar `details`; the rejected input is never kept. The diagnostic's `details.issues` repeats them. |
| `toWirePayload(value, subject)`, `encodeJsonPayload`, `decodeJsonPayload`, `jsonPayloadMediaType` | Functions, constant | The JSON wire format: exact copies; `HOLQA_PAYLOAD_NOT_SERIALIZABLE` or `HOLQA_PAYLOAD_MALFORMED` with a JSON path. |
| `prepareWirePayload(schema, value, subject)` | Function | Encodes a value and validates the encoded copy; what queue `send` uses. |
| `PayloadError` | Class | `HolqaError` with the offending JSON `path`. |
| `createMessageCodec(schema, options)`, `MessageCodec`, `MessageCodecOptions`, `DecodedMessage` | Function, types | Versioned envelopes, encoded and decoded with one schema; rejects unaccepted versions with `HOLQA_PAYLOAD_VERSION_UNSUPPORTED`. |
| `MessageEnvelope`, `messageEnvelopeFormat`, `encodeMessageEnvelope`, `decodeMessageEnvelope` | Type, constant, functions | The `holqa.message/1` envelope. |
| `PayloadCodec`, `jsonPayloadCodec`, `bytesPayloadCodec` | Type, constants | Explicit codecs for JSON and binary payloads. |
| `SchemaAdapter`, `SchemaSide`, `schemaSides`, `SchemaSideConversion`, `SchemaSideDescription`, `SchemaConversionProblem`, `RuntimeOnlyConstraint`, `RuntimeOnlyKind` | Types, constant | The contract schema-library adapters implement. See [schema contracts](schema-contracts.md). |
| `descriptorKey`, `descriptorProtocol` | Constants | `"~holqa"` and `1`. |
| `AppDescriptor`, `ResourceDescriptor`, `ResourceDescriptorOf<K>`, `HandlerDescriptor`, `HandlerDescriptorOf<T>`, `ConfigDescriptor`, `Described<D>` | Types | The descriptor protocol. |
| `getDescriptor`, `getAppDescriptor`, `getResourceDescriptor`, `getHandlerDescriptor`, `getConfigDescriptor` | Functions | Structural descriptor readers; return `undefined` for other protocol versions, unknown kinds and malformed values. |
| `ResourceKindMap`, `ResourceKind`, `DrivenResourceKind`, `resourceKinds`, `isResourceKind` | Types, constant, function | The resource kind registry (`queue`, `bucket`, `schedule`, `http.api`) and its per-kind `config`, `requirements`, `schemas`, `capabilities` and `driver` types. |
| `TriggerKindMap`, `TriggerKind`, `triggerKinds`, `isTriggerKind`, `resourceKindOfTrigger` | Types, constant, functions | The trigger kind registry (`queue.message`, `bucket.object-created`, `schedule.tick`, `http.route`). |
| `HandlerDefinition`, `Trigger`, `ResourceReference`, `InvocationContext`, `HandlerInvoke` | Types | Handler metadata (JSON) and the executable `invoke` contract. |
| `RuntimeBinding`, `BindingCapabilities`, `ResourceDrivers`, `BindingSlot`, `createBindingSlot` | Types, function | The data-plane binding contract. |
| `bindApp(app, binding)` | Function | Installs a binding after checking capabilities and drivers; returns an unbind function. Throws `HOLQA_RUNTIME_ALREADY_BOUND` or `HOLQA_BINDING_CAPABILITY_UNSUPPORTED`. |
| `requireBinding`, `resolveDriver`, `readConfig` | Functions | Resolve the current binding, a resource's driver or a configuration value; throw `HOLQA_RUNTIME_NOT_BOUND` without a binding. |
| `checkCapabilities(resource, advertised, bindingName)` | Function | Compares a resource's requirements with the capabilities a binding advertises for its kind; one `HOLQA_BINDING_CAPABILITY_UNSUPPORTED` diagnostic per shortfall. |

Resource identifier grammar: `^[a-z][a-z0-9]*(?:[-.][a-z0-9]+)*$`, 1–63 characters (for example `order-processing`, `orders.process`). The grammar is an initial proposal and may be revised before 1.0 ([ADR 0004](../architecture/decisions/0004-stable-logical-resource-identities.md)).

## `@holqa/sdk`

- **Path:** `packages/sdk`
- **Status:** Implemented (application and resource model). Private. HTTP routes, RPC procedures and `staticSite` are proposed.
- **Purpose:** Declare applications, resources, configuration and handlers with types inferred from source. Runtime-neutral.
- **Entry point:** `@holqa/sdk` → `dist/index.js`, `dist/index.d.ts`.
- **Internal dependencies:** `@holqa/core`.

| Export | Kind | Description |
| --- | --- | --- |
| `defineApp(definition)` | Function | Validates and defines an application; returns `{ name, resources, env, "~holqa" }`. See [application model](../concepts/application-model.md). |
| `defineResources(group)`, `composeResources(...groups)` | Functions | Typed resource groups for registries split across modules; `composeResources` rejects duplicate aliases. |
| `queue`, `bucket`, `schedule`, `http.api` | Functions | Resource factories returning typed handles. The object-created event schema of `bucket(...).onObjectCreated` implements Standard JSON Schema (vendor `holqa`), so compilers can record it. |
| `secret(schema)`, `variable(schema, { default? })` | Functions | Configuration entries. |
| `App`, `AppDefinition`, `ConfigValues`, `HandlerDiscoveryOptions` | Types | Application types. |
| `QueueHandle`, `BucketHandle`, `ScheduleHandle`, `HttpApiHandle`, `ResourceHandle`, `AnyResource`, `ResourceRecord` | Types | Handle types. |
| `QueueConsumer`, `ObjectCreatedHandler`, `ScheduleHandler`, `HandlerRegistration` | Types | Handler registrations. |
| `QueueMessageInput`, `QueueMessageOutput`, `QueueConsumerFor`, `ResourceIdOf`, `ResourceIds`, `ResourceById`, `ResourceAliasesOfKind` | Types | Type helpers derived from handles. |
| `HolqaTypeError`, `CheckResourceId`, `CheckUniqueResourceIds`, `DuplicateResourceIds`, `ResourceIdProblem`, `CheckDistinctAliases` | Types | Compile-time declaration checks. |

## `@holqa/testing`

- **Path:** `packages/testing`
- **Status:** Implemented (type assertions only). Private. Deterministic execution, simulated delivery and fixtures are planned.
- **Entry point:** `@holqa/testing` → `dist/index.js`, `dist/index.d.ts`.
- **Internal dependencies:** `@holqa/sdk`.

| Export | Kind | Description |
| --- | --- | --- |
| `Equal`, `NotEqual`, `Expect`, `ExpectFalse` | Types | Exact type equality and compile-time assertions (`type _ = Expect<Equal<A, B>>`). |
| `IsAny`, `IsNever`, `IsUnknown`, `Extends` | Types | Type predicates. |
| `Accepts<Fn, Arg>` | Type | Whether a function such as `typeof resources.orders.send` accepts an argument type. |
| `TypeErrorMessage<Check>`, `HasTypeError<Check>` | Types | Inspect the result of the SDK's compile-time checks. |
| `assertType<T>(value)` | Function | Compile-time check that a value has type `T`; no run-time effect. |

## `@holqa/compiler`

- **Path:** `packages/compiler`
- **Status:** Implemented (manifest pipeline, canonical JSON, schema contracts). Private. Client generation, bundling and comparison with a deployed manifest are planned ([compiler](../architecture/compiler.md)).
- **Purpose:** Turns an evaluated application into a deterministic manifest and entry point map, with structured diagnostics. Runtime-neutral: hosts evaluate modules and pass them in. See the [compiler specification](compiler-specification.md).
- **Entry points:** `@holqa/compiler` → `dist/index.js`, `dist/index.d.ts`; `@holqa/compiler/manifest-v1.schema.json`; `@holqa/compiler/entrypoints-v1.schema.json`.
- **Internal dependencies:** `@holqa/core`.

| Export | Kind | Description |
| --- | --- | --- |
| `compileApplication(input)` | Function | Compiles `{ app, appModule, modules, runtime, adapters?, sources? }` into `{ ok: true, manifest, entrypoints, diagnostics }` or `{ ok: false, diagnostics }`. Collects every problem. |
| `CompileApplicationInput`, `CompileApplicationResult`, `CompileApplicationSuccess`, `CompileApplicationFailure` | Types | Its input and result. |
| `selectHandlerModules(files, discovery, appModule)`, `HandlerModuleSelection` | Function, type | Selects handler modules from root-relative file paths with the application's patterns. |
| `compileGlob(pattern)`, `GlobMatcher` | Function, type | Host-independent glob matching (`*`, `?`, `**`, `{a,b}`). |
| `portableModulePath(path)` | Function | Normalizes a root-relative path; `undefined` for absolute or escaping paths. |
| `discoverHandlers(modules)`, `EvaluatedModule`, `DiscoveredHandler`, `HandlerDiscoveryResult` | Function, types | Finds handler registrations among evaluated modules' exports. |
| `Manifest`, `ManifestApplication`, `ManifestResource`, `ManifestResourceOf`, `ManifestHandler`, `ManifestTrigger`, `ManifestTriggerOf`, `ManifestConfigEntry`, `ManifestSchema`, `ManifestSchemaReference`, `ManifestSchemaReferences`, `ManifestRuntime`, `ManifestVersion` | Types | Manifest version 1. |
| `manifestVersion`, `manifestRuntimes`, `manifestJsonSchema` | Constants | `1`, `["bun"]`, and the manifest's JSON Schema. |
| `EntrypointMap`, `HandlerEntrypoint`, `entrypointsFormat`, `entrypointsJsonSchema` | Types, constants | The `holqa.entrypoints/1` map and its JSON Schema. |
| `serializeManifest(manifest)`, `serializeEntrypoints(map)` | Functions | Canonical JSON text. |
| `fingerprintManifest(manifest)`, `manifestFingerprintPrefix` | Function, constant | `sha256:` over the canonical manifest text. |
| `validateManifest(value)`, `validateEntrypoints(value, manifest)` | Functions | Readers for untrusted documents: `HOLQA_MANIFEST_INVALID`, `HOLQA_MANIFEST_VERSION_UNSUPPORTED`. |
| `buildResourceGraph(manifest)`, `ResourceGraph`, `GraphNode`, `GraphEdge`, `GraphRelation` | Function, types | The graph of declared relationships. |
| `moduleEvaluationFailure(path, error)` | Function | `HOLQA_MODULE_EVALUATION_FAILED` for an error thrown while a host imported a module. |
| `sortDiagnostics(diagnostics)`, `hasErrors(diagnostics)` | Functions | Deterministic ordering; error detection. |
| `canonicalJsonStringify(value)` | Function | Deterministic JSON: sorted keys at every depth, 2-space indent, no trailing newline, `-0` → `0`. Throws `CanonicalJsonError` for values with no canonical form. |
| `CanonicalJsonError` | Class | Error with a `diagnostic` property (code `HOLQA_MANIFEST_NOT_SERIALIZABLE`); the message includes the JSON path, such as `$.resources[0].id`. |
| `CanonicalJsonValue` | Type | `null`, boolean, number, string, arrays, and plain objects of these. |
| `normalizeSchema(schema, options)`, `NormalizeSchemaOptions`, `NormalizedSchema` | Function, types | Converts a Standard Schema into a canonical `SchemaContract` through a vendor adapter (or, unverified, its Standard JSON Schema converter). Returns warnings, or `HOLQA_SCHEMA_UNSUPPORTED` errors. |
| `describeSchemaContract(schema, options)`, `DescribeSchemaContractOptions`, `DescribedSchemaContract` | Function, types | Normalizes and fingerprints a schema into a `SchemaContractRecord` with its `schemaVersion`. |
| `SchemaContract`, `SchemaContractRecord`, `SchemaOutputContract`, `SchemaSource`, `SchemaFidelity`, `schemaContractFormat`, `jsonSchemaDialect` | Types, constants | The `holqa.schema-contract/1` format. |
| `canonicalizeJsonSchema(schema)` | Function | Sorts and de-duplicates set-like keywords; never removes a constraint. |
| `fingerprintSchemaContract(contract)`, `schemaFingerprintPrefix` | Function, constant | `sha256:` over the canonical JSON of the contract's wire-relevant parts. |
| `checkSchemaCompatibility(previous, next, options)` | Function | Classifies changes by role (`message`, `request`, `response`) as safe, potentially breaking, unverifiable or breaking, with diagnostics. |
| `SchemaCompatibilityReport`, `SchemaChange`, `SchemaChangeKind`, `ChangeClassification`, `ChangeDirection`, `ContractRole`, `ContractVersion`, `CheckSchemaCompatibilityOptions`, `AcceptanceCertainty` | Types | The JSON-serializable compatibility report. |

`canonicalJsonStringify` rejects `undefined`, functions, symbols, bigints, `NaN`, `Infinity`, non-plain objects (such as `Date`, `Map`, class instances), and circular references. Schema contracts are described in [schema contracts](schema-contracts.md).

## `@holqa/zod`

- **Path:** `packages/integrations/zod`
- **Status:** Implemented. Private.
- **Purpose:** The Zod 4 schema adapter (classic and Mini). See [schema contracts](schema-contracts.md#zod-support) and the [package README](../../packages/integrations/zod/README.md).
- **Entry point:** `@holqa/zod` → `dist/index.js`, `dist/index.d.ts`.
- **Internal dependencies:** `@holqa/core`. Peer dependency: `zod` `^4.6.7`.

| Export | Kind | Description |
| --- | --- | --- |
| `zodAdapter` | Constant | The default `SchemaAdapter` for the `zod` vendor; `library` is the installed Zod version. |
| `createZodAdapter(options?)`, `ZodAdapterOptions` | Function, type | Creates an adapter with an optional `library` identifier; throws when Zod is not version 4. |
| `isZodSchema(value)` | Function | Structural check for Zod 4 schemas. |
| `zodVendor` | Constant | `"zod"`. |

## `@holqa/cli`

- **Path:** `packages/cli`
- **Status:** Implemented (help, version, `--json`, `inspect`, `build --manifest`). Private. Other workflow commands and bundling are proposed. See [CLI reference](cli.md).
- **Purpose:** Holqa developer CLI.
- **Entry points:** library `@holqa/cli` → `dist/index.js`; binary `holqa` → `dist/bin.js`; analysis process entry `dist/analyze.js` (internal, spawned by the CLI). Runs on Bun, `engines.bun >= 1.3.13`.
- **Internal dependencies:** `@holqa/core`, `@holqa/compiler`. Allowed in future: `@holqa/local`, `@holqa/runtime-bun`.

| Export | Kind | Description |
| --- | --- | --- |
| `runCli(argv, io, version, host?)` | Function | Runs the CLI against split arguments; writes through `io`; resolves to an exit code. `host` defaults to `createProcessHost()`. |
| `CliIo` | Type | `{ stdout(text), stderr(text) }`. |
| `CliHost`, `AnalysisOutcome`, `AnalysisSuccess`, `AnalysisFailure` | Types | Working directory, analysis and file writing, injected for tests. |
| `createProcessHost(options?)`, `ProcessHostOptions`, `forwardedEnvironment` | Function, type, constant | The default host: analysis in a separate Bun process with an allowlisted environment, `--no-install` and a timeout. |
| `exitCodes` | Constant | `{ success: 0, failure: 1, usage: 2 }`. |
| `implementedCommands`, `proposedCommands` | Constants | Implemented and proposed commands with one-line summaries. |
| `ProposedCommand` | Type | `{ name, summary }`. |
| `findProposedCommand(positionals)` | Function | Finds the longest proposed command matching the leading positional arguments. |

## `@holqa/example-schema-evolution`

- **Path:** `examples/schema-evolution`
- **Status:** Implemented. Private; not published.
- **Purpose:** One Zod order message, validated on publish (`queue(...).send`, message codecs) and on receipt, normalized, fingerprinted, and checked against compatible and breaking versions. See its [README](../../examples/schema-evolution/README.md).

## `@holqa/example-manifest`

- **Path:** `examples/manifest`
- **Status:** Implemented. Private; not published.
- **Purpose:** Applications written with `@holqa/sdk` and Zod, compiled by the built `holqa` binary: a golden manifest, identical bytes across processes, directories and a relocated copy, an unchanged manifest after renaming every local name, and diagnostics for an invalid application. See its [README](../../examples/manifest/README.md).

## `@holqa/example-package-smoke`

- **Path:** `examples/package-smoke`
- **Status:** Implemented. Private; not published.
- **Purpose:** Consumes `@holqa/core`, `@holqa/compiler`, `@holqa/cli`, `@holqa/sdk`, `@holqa/testing`, and `@holqa/zod` through their public exports after they are built. It verifies that `dist/` contains JavaScript and declarations, that no unresolved `@/` aliases remain in emitted `.js` or `.d.ts` files, that the built `holqa` binary runs, that the built compiler compiles an SDK application, and that the manifest JSON Schemas and the CLI's analysis entry point are shipped.
- **Run:** `pnpm --filter @holqa/example-package-smoke test` (after `pnpm build`), or as part of `pnpm test` / `pnpm check`.

## Planned packages

| Package | Intended responsibility | Allowed internal dependencies |
| --- | --- | --- |
| `@holqa/runtime-bun` | Execute handlers on Bun; HTTP via the Fetch API; invocation adapters; concurrency limits. | `core` |
| `@holqa/local` | Local runtime drivers: queue, storage, and scheduler emulation; event inspection. | `core`, `runtime-bun` |
| `@holqa/testing` (extensions) | Deterministic test harness; simulated deliveries, retries, failures; fixtures. | `core`, `sdk`, `local`, `runtime-bun` |
| `@holqa/client` | Fetch-based runtime for generated, browser-safe clients. Runtime-neutral. | `core` |
| `packages/integrations/*` (except `zod`) | Schema, handler, transport, and client adapters. See [integrations](../integrations/index.md). | `core`, `sdk`, `client` |

See the [roadmap](../roadmap.md) for when each is expected.

## Related

- [Package boundaries](../architecture/package-boundaries.md)
- [Architecture overview](../architecture/overview.md)
- [Releasing](../contributing/releasing.md)
