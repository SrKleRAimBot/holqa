# Compiler specification

> **Status:** **Implemented** — application analysis, handler discovery, graph validation, manifest version 1, the entry point map and the `holqa inspect` / `holqa build --manifest` commands. Client generation, bundling of executable artifacts and comparison with a deployed manifest are **Planned**.

This page specifies what `@holqa/compiler` and the `holqa` CLI produce from an application: the manifest format (the intermediate representation), the entry point map, the determinism guarantees, the security model of analysis, which declaration patterns are supported, the diagnostics, and the compatibility rules. The architecture is described in [compiler](../architecture/compiler.md) and the decisions in [ADR 0014](../architecture/decisions/0014-evaluation-based-manifest-extraction.md) and [ADR 0022](../architecture/decisions/0022-manifest-v1-and-entry-point-map.md).

## Pipeline

| Stage | Where | What happens |
| --- | --- | --- |
| 1. Application loading | CLI analysis process | Imports the application module (`infra.ts` by default) and reads its default export. |
| 2. Handler discovery | CLI analysis process, `selectHandlerModules` | Lists files under the application root, selects modules with the application's `handlers` patterns, and imports them in path order. |
| 3. Schema adapters | CLI analysis process | Loads `@holqa/<vendor>` for every Standard Schema vendor the application uses, when the package resolves from the application root. |
| 4. Compilation | `compileApplication` | Reads descriptors, normalizes every declaration, validates the graph, describes and fingerprints every schema. Runtime-neutral. |
| 5. Serialization | `serializeManifest`, `serializeEntrypoints` | Canonical JSON. |
| 6. Trust boundary | CLI parent process, `validateManifest`, `validateEntrypoints` | The CLI validates everything the analysis process reports before printing or writing it. |

`compileApplication` never loads code: a host passes the evaluated application and modules. The CLI is the only host today.

## Manifest version 1

The manifest is canonical JSON (keys sorted at every depth, two-space indentation). Its JSON Schema is [`packages/compiler/schemas/manifest-v1.schema.json`](../../packages/compiler/schemas/manifest-v1.schema.json), exported as `manifestJsonSchema` and as the package subpath `@holqa/compiler/manifest-v1.schema.json`. TypeScript definitions: `Manifest` and related types in `@holqa/compiler`.

| Field | Content |
| --- | --- |
| `manifestVersion` | `1`. |
| `application` | `name` (identifier grammar) and optional `description`. |
| `runtime` | The execution runtime the build targets: `"bun"`. |
| `resources` | One entry per declared resource, sorted by `id`: `id`, `kind`, normalized `config` and `requirements` for the kind, and `schemas` (references by role). |
| `handlers` | One entry per handler, sorted by `id`: `id`, `trigger` (`kind`, `resource: { kind, id }`, normalized `options`) and `schemas`. |
| `config` | Required configuration (environment bindings), sorted by `name`: `name`, `kind` (`secret` or `variable`), `schema`, and `default` for variables that declare one. Values are never recorded. |
| `requiredCapabilities` | The capabilities a binding must provide, sorted and unique (see below). |
| `schemas` | The schema table: normalized schema contracts keyed by `sha256:` fingerprint. |

What the manifest deliberately does not contain: module paths, export names, TypeScript variable names, resource aliases, handler discovery patterns, provider names or settings, absolute paths, timestamps, the compiler's version, and configuration values.

### Resources

| Kind | `config` | `requirements` | Schema roles |
| --- | --- | --- | --- |
| `queue` | `schemaVersion` | `delivery` (`at-least-once`), `deadLetter`, optional `maxAttempts`, optional `backoff` (`{ strategy: "fixed", delaySeconds }` or `{ strategy: "exponential", initialDelaySeconds, maxDelaySeconds, multiplier? }`) | `message` (required) |
| `bucket` | `{}` | `access` (`private` or `public-read`) | none |
| `schedule` | `cron` (five fields, single spaces), `timezone` | `overlap` (`skip` or `allow`) | none |
| `http.api` | `basePath`, optional `docs: { title, version }` | `{}` | none |

Unknown settings are rejected with `HOLQA_DECLARATION_INVALID`; nothing is dropped or passed through. This is what keeps provider-specific configuration out of the manifest.

### Handlers and triggers

| Trigger | Resource kind | `options` | Schema roles |
| --- | --- | --- | --- |
| `queue.message` | `queue` | optional `concurrency` | `message` |
| `bucket.object-created` | `bucket` | optional `prefix` | `object` |
| `bucket.object-deleted` | `bucket` | optional `prefix` | `object` |
| `schedule.tick` | `schedule` | `{}` | none |
| `http.route` | `http.api` | `method`, `path` (`/orders/:orderId`) | optional `params`, `query`, `headers`, `body`; `response.<status>` |
| `http.procedure` | `http.api` | `operation` (`query` or `mutation`) | `output` (required), optional `input` |

Routes and procedures are registered with the SDK's `route(...)` and `procedure(...)` and executed by `@holqa/runtime-bun` ([runtime reference](runtime.md)). A procedure has no path option: it is served at `<basePath>/rpc/<id>`.

The `http.procedure` trigger and the `headers`, `input` and `output` roles were added to the manifest version 1 JSON Schema without a new version ([ADR 0023](../architecture/decisions/0023-common-invocation-engine-and-http-rpc-execution.md), decision 9), and so were the `bucket.object-deleted` trigger and a queue's `backoff` requirement ([ADR 0024](../architecture/decisions/0024-event-delivery-sources-and-local-drivers.md), decision 8). Manifests that use none of them are unchanged byte for byte; readers built before an addition reject manifests that use it.

### Schema references and the schema table

A schema reference is `{ fingerprint, source, schemaVersion? }`:

- `fingerprint` names an entry of `schemas` (`fingerprintSchemaContract`, see [schema contracts](schema-contracts.md#fingerprints-and-versions)).
- `source` records the vendor, the converting library and its version (for example `zod@4.6.7`) and the fidelity. It is kept per use because it is not part of the fingerprint.
- `schemaVersion` appears on a queue's `message`, from the queue's declared `schemaVersion`.

Table entries are `holqa.schema-contract/1` contracts without `source`. Two uses with the same fingerprint share one entry. If their non-fingerprinted text differs (for example a library's wording of a runtime-only constraint), the entry with the smallest canonical text is kept, which is deterministic.

The wire side of every role (including a procedure's `input`) is the schema's input, except `response.<status>` and a procedure's `output`, which are sent after validation and therefore use the output. A wire side without a portable description fails with `HOLQA_SCHEMA_UNSUPPORTED`; an unrepresentable non-wire side (for example a transform's output on a queue message) is recorded as `representable: false`.

Schemas whose vendor is `holqa` (written by Holqa, such as the SDK's object-created and object-deleted events) are described by a built-in adapter from their Standard JSON Schema and recorded as `verified` with library `holqa`.

### Required capabilities

| Source | Capabilities |
| --- | --- |
| Queue | `queue`, `queue.delivery.at-least-once`; `queue.dead-letter` when `deadLetter` is `true`; `queue.max-attempts` when `maxAttempts` is declared; `queue.backoff.<strategy>` when `backoff` is declared |
| Bucket | `bucket`, `bucket.access.<access>` |
| Schedule | `schedule`, `schedule.overlap.<overlap>` |
| HTTP API | `http.api` |
| Static site | `static.site`; `static.site.spa-fallback` when `spaFallback` is `true` |
| Trigger | `trigger.<trigger kind>`, for example `trigger.queue.message` |

The numeric values of `maxAttempts` and `backoff` are in the queue's `requirements`. `requiredCapabilities` in `@holqa/core` derives these strings; the compiler records what it returns, so the vocabulary only grows. `checkCapabilities` in `@holqa/core` compares requirements with a binding when it is installed, and `holqa bindings validate` and `holqa inspect --capabilities` compare them with a binding configuration before anything runs ([binding contracts](bindings.md#capabilities)).

## Entry point map

The build also writes an entry point map: build metadata that says where each handler is implemented. Its JSON Schema is [`entrypoints-v1.schema.json`](../../packages/compiler/schemas/entrypoints-v1.schema.json) (`entrypointsJsonSchema`, `EntrypointMap`).

| Field | Content |
| --- | --- |
| `format` | `holqa.entrypoints/1`. |
| `manifest` | The fingerprint of the manifest it belongs to: `sha256:` over the manifest's canonical JSON text (`fingerprintManifest`). |
| `application` | `module` (the application module, root-relative) and the `handlers` discovery patterns. |
| `handlers` | Sorted by `id`: `id`, `module` (root-relative, `/` separators), `export` (`default` when the module exports the handler as default, otherwise the first name in `exports`), and `exports`. |

Moving a file or renaming an export changes the entry point map and its contents, never the manifest. `validateEntrypoints` rejects a map whose `manifest` fingerprint or handler list does not match the manifest. Bundling executable artifacts from this map is **Planned**.

## Resource graph

`buildResourceGraph(manifest)` derives the graph from a manifest, so it can be built from a `manifest.json` without loading code. `holqa inspect --json` includes it.

| Node `type` | Key |
| --- | --- |
| `application` | `application:<name>` |
| `resource` | `resource:<id>` (with `kind` and its capabilities) |
| `handler` | `handler:<id>` (with its trigger kind) |
| `config` | `config:<name>` (with `secret` or `variable`) |
| `schema` | `schema:<fingerprint>` |

| Relation | From → to |
| --- | --- |
| `declares` | application → resource |
| `registers` | application → handler |
| `requires` | application → configuration entry |
| `triggers` | resource → handler (label: the trigger kind) |
| `schema` | resource, handler or configuration entry → schema (label: the role) |

Only relationships the declarations state are recorded. Which resources a handler publishes to at run time (for example `send` on another queue) is found by [event analysis](#event-analysis) instead, and is not part of this graph or of the manifest. Which configuration a handler reads is not recorded. Declared dependencies are **Planned** ([resource graph](../concepts/resource-graph.md#dependencies-and-least-privilege)).

## Event analysis

`compileApplication` also returns `events`, an `EventAnalysis` with the application's event dependency graph and its cycles ([event safety](../concepts/event-safety.md), [ADR 0026](../architecture/decisions/0026-event-safety-analysis-lineage-and-execution-guards.md)). It is not part of the manifest: publications follow from handler code, so implementation changes must not change the manifest or its fingerprint. `holqa inspect --cycles` prints it.

| Input | Use |
| --- | --- |
| `sources` | Each handler's code is located (the `handler` property of the registration whose `id` is the handler's identifier, or the function it names) and scanned for `send`, `put` and `delete` calls. Without sources, only declared publications are known and handlers are `unavailable`. |
| `modules`, `app`, `appExports` | Evaluated namespaces. A call's receiver (`resources.orders`, an alias, a destructured name, an import) is resolved by reading own data properties of evaluated values, never by running getters, and kept only when it is a queue or bucket handle. |
| `resolveModule(specifier, from)` | Resolves imports as the runtime does. The CLI passes Bun's resolver, limited to modules inside the application root and outside `node_modules`. Without it, relative specifiers and `@/`, `~/` and `#` aliases are matched against known paths. |
| Handler `events` | Declared `publishes` (known edges), `cycle` allowances and limits. Malformed policies are `HOLQA_DECLARATION_INVALID` errors; a declared target the application does not declare is `HOLQA_RESOURCE_NOT_FOUND`; only queues and buckets can be targets; `idempotency` is only valid on queue consumers and object event handlers. |

| Graph element | Content |
| --- | --- |
| Resource node | `{ key: "resource:<id>", type, id, kind }` |
| Handler node | `{ key: "handler:<id>", type, id, trigger, coverage, location?, cycle?, maxDepth?, maxPublications? }`; `coverage` is `complete`, `partial` (unresolved calls, or the registration was not found and the whole module was scanned as `potential`) or `unavailable`. |
| Consumption edge | `{ from: resource, to: handler, relation: "consumes", event, prefix? }`; `event` is `queue.message`, `object.created`, `object.deleted`, `schedule.tick` or `http.request`. |
| Publication edge | `{ from: handler, to: resource, relation: "publishes", operation, certainty, origin, call?, location?, keyPrefix?, keyExact?, via? }`; `certainty` is `known` or `potential`, `origin` is `analysis` or `declared`. |
| `unresolved` | Publication-like calls whose receiver could not be resolved (`certainty: "unknown"`, no target). |

Cycles are strongly connected components of the handler graph (a publication leads to every handler that consumes the event it causes, when the object key can match the handler's prefix). Each `EventCycle` is `{ status, certainty, handlers, path, allowedBy? }`: `reported` cycles avoid every handler with an `events.cycle` allowance and produce one `HOLQA_EVENT_CYCLE` diagnostic (a warning when the representative path is all `known`, information otherwise); `allowed` cycles pass through such a handler and produce none. Diagnostics never fail compilation. The analysis is deterministic: module order, discovery order and absolute paths do not change it.

Helper functions are followed up to four calls deep, in the same module or in an application module whose source is available; publications found through them, through a handle passed to another function, or with an object key whose prefix may or may not match are `potential`.

## Determinism

Given the same application source, the same installed dependencies (lockfile) and the same Holqa version, `holqa build --manifest` writes byte-identical `manifest.json` and `entrypoints.json`. This is tested across separate processes, working directories and a relocated copy of an application ([`examples/manifest`](../../examples/manifest/README.md)).

| Guarantee | How |
| --- | --- |
| No timestamps, random values or compiler version | None are written. |
| No machine-specific paths | Module paths are root-relative with `/` separators; absolute paths, drive letters and `..` are rejected (`HOLQA_DECLARATION_INVALID`). |
| No dependence on discovery or declaration order | Every list is sorted by identity using UTF-16 code unit order, never the locale. |
| No dependence on key order | Canonical JSON sorts keys at every depth. |
| Stable identity | Handlers and resources are keyed by their declared `id`. Variable names, aliases, export names and file names are absent from the manifest. |
| Stable glob semantics | Handler patterns are matched by the compiler's own matcher, not the host's. |
| Controlled environment | The analysis process runs with `TZ=UTC`, `LC_ALL=C`, an allowlisted environment and no `.env` files. |

Controlled build inputs that legitimately change the manifest: the application's declarations, the installed version of a schema library or adapter (recorded in `source.library`, and possibly changing fingerprints), and the Holqa version (a normalization change requires a new `manifestVersion`). Because `source.library` includes the adapter's library version (for example `zod@4.6.7`), even a patch upgrade of a schema library changes the manifest bytes and its fingerprint. Application code that computes declarations from the clock, randomness or the file system defeats these guarantees; declarations must be pure ([ADR 0003](../architecture/decisions/0003-explicit-resource-declarations.md)).

## Security model

**Compiling an application runs its code.** `holqa inspect` and `holqa build` import the application module, every handler module and everything they import, like running the application's tests. Only analyze applications you would also run.

The CLI reduces exposure by evaluating modules in a dedicated Bun process:

| Control | Effect |
| --- | --- |
| Allowlisted environment | Only `PATH`, `HOME`, `TMPDIR`, `TEMP`, `TMP` and `SYSTEMROOT` are passed, plus `TZ=UTC` and `LC_ALL=C`. Deployment credentials and application secrets in the CLI's environment are not handed to evaluated code. |
| `bun --no-env-file` | `.env` files in the application root are not loaded. |
| `bun --no-install` | Evaluation never downloads packages. |
| Closed standard input, application root as working directory | Evaluation cannot prompt. |
| Timeout (60 seconds) | Hanging evaluation is killed and reported as `HOLQA_ANALYSIS_FAILED`. |
| IPC report, validated | The report travels over an IPC channel, so printed output cannot be mistaken for it. The CLI checks every diagnostic code and validates the manifest and entry point map before use. |
| Process killed after reporting | Timers or servers left open by modules do not keep analysis running. |

**This is not a sandbox.** A separate process is not a security boundary for untrusted code: evaluated code runs as the same user, so it can still read and write files (including `.env` files and credential files under `HOME`), on some systems read the environment of other processes of the same user, including the CLI, and use the network. A real sandbox (restricted file system and network) remains future hardening ([ADR 0014](../architecture/decisions/0014-evaluation-based-manifest-extraction.md)).

Secrets: the compiler records a secret's name and schema, never a value, and rejects a secret that declares a default. Configuration values are never read during compilation; reading one at module top level fails with `HOLQA_MODULE_EVALUATION_FAILED` citing `HOLQA_RUNTIME_NOT_BOUND`. Diagnostics may quote a module's error message, and `HOLQA_ANALYSIS_FAILED` quotes the last 4000 characters of the analysis process's output in `details.output`; the CLI's environment and `.env` files are not handed to the process, but these texts can contain whatever the application's code prints.

Static analysis is used only to add line and column numbers to diagnostics, by finding identifiers as string literals in source files. It never changes what is accepted or recorded.

## Supported and rejected declaration patterns

| Pattern | Result |
| --- | --- |
| `export default defineApp(...)` in the application module | Supported. |
| Resources declared inline, in other modules, with `defineResources` / `composeResources`, or computed by deterministic code | Supported: the compiler sees the evaluated result. |
| Schemas imported from other modules or packages, composed or extended | Supported. |
| Handler registrations exported from modules matched by `handlers` (default or named, several per module, re-exported) | Supported. A registration exported several times counts once and is attributed to the first module in path order. |
| Configuration and resource operations used inside handlers or lazily | Supported. |
| A default export that is not a Holqa application | `HOLQA_APP_INVALID`. |
| A registration that is not exported, or whose module no pattern matches | Not part of the application; it is not discovered. A pattern matching no module is `HOLQA_HANDLER_PATTERN_UNMATCHED` (warning). |
| Two different registrations with the same `id` | `HOLQA_HANDLER_ID_DUPLICATE`. |
| A trigger on a resource the application does not declare | `HOLQA_RESOURCE_NOT_FOUND`, with the declared resources of that kind in the hint. |
| A trigger on a resource of another kind, malformed options, or a consumer whose message contract differs from its queue's | `HOLQA_TRIGGER_INVALID`. |
| A second consumer of one queue | `HOLQA_QUEUE_CONSUMER_DUPLICATE`. |
| Two routes with the same method and path shape (parameter names ignored) on one API, or a route on a procedure's path (`POST <basePath>/rpc/<id>`, and `GET` for queries) | `HOLQA_ROUTE_CONFLICT`. A static segment and a parameter (`/orders/new`, `/orders/:id`) do not conflict: routers must prefer the static segment. |
| Unknown settings, malformed requirements, invalid configuration names, a secret with a default, a non-JSON default | `HOLQA_DECLARATION_INVALID`. |
| A schema without a portable wire form | `HOLQA_SCHEMA_UNSUPPORTED`. |
| Handler patterns that are absolute or contain `..` | `HOLQA_DECLARATION_INVALID`. |
| Top-level resource operations or configuration reads, or any module that throws while being imported | `HOLQA_MODULE_EVALUATION_FAILED`. |
| Top-level code that waits (network, timers) or ends the process | `HOLQA_ANALYSIS_FAILED`. |
| Declarations computed from the clock, randomness, environment variables or files | Unsupported. Not reliably detectable; output is not reproducible, and environment variables (other than the allowlist) and `.env` files are absent during analysis. |
| Descriptors from another protocol version (mixed Holqa versions) | `HOLQA_APP_INVALID` or `HOLQA_DECLARATION_INVALID`. |

Files under `node_modules` and directories whose name starts with `.` (including the default `.holqa` output directory) are never discovered, and symbolic links are not followed.

## Schema adapters

The CLI loads one adapter package per Standard Schema vendor used by the application, by convention `@holqa/<vendor>` (for example `@holqa/zod` for vendor `zod`), resolved from the application root. Install the adapter in the application. Without one, a schema that implements Standard JSON Schema is described by its own converter with `HOLQA_SCHEMA_FIDELITY_UNVERIFIED`; otherwise it is rejected with `HOLQA_SCHEMA_UNSUPPORTED`. `compileApplication` takes adapters explicitly.

## Diagnostics

Every problem is a `Diagnostic` with a registered code ([diagnostic codes](diagnostic-codes.md)). Compilation collects every problem rather than stopping at the first, and sorts diagnostics by file, line, column, code and message. Locations are relative to the application root in `compileApplication` output and relative to the working directory in CLI output. A failed compilation produces no manifest.

## Compatibility rules

| Contract | Rule |
| --- | --- |
| `manifestVersion` | Readers accept only versions they know; `validateManifest` reports `HOLQA_MANIFEST_VERSION_UNSUPPORTED` for others. The version 1 schema is closed (`additionalProperties: false`), so any new field, any structural change and any change to normalization or fingerprinting is a new manifest version. One exception, until the first package is published ([ADR 0023](../architecture/decisions/0023-common-invocation-engine-and-http-rpc-execution.md) decision 9): new trigger kinds and schema roles that leave every existing manifest valid and byte-identical (`http.procedure`, `headers`, `input`, `output`) extend version 1; readers built before them reject manifests that use them. |
| Identity | A resource or handler is the same logical entity as long as its `id` is unchanged. Changing an `id` is a removal and an addition, which future deployment tooling must treat as replacement. Renaming variables, aliases, files or exports changes nothing in the manifest. |
| Schema fingerprints | A changed fingerprint means the contract may have changed. Use `checkSchemaCompatibility` to classify the change ([schema contracts](schema-contracts.md#compatibility)); comparing against the deployed manifest automatically is **Planned**. |
| Entry point map | `holqa.entrypoints/1` is versioned separately from the manifest and tied to one manifest by fingerprint. |
| Diagnostic codes, CLI exit codes and `--json` shapes | Public contracts; codes are never renamed or reused ([CLI](cli.md)). |
| Schema libraries | Upgrading a schema library or adapter may change `source.library` and fingerprints without a contract change. |

## API summary

| Export (`@holqa/compiler`) | Purpose |
| --- | --- |
| `compileApplication(input)` | Compiles `{ app, appModule, modules, runtime, adapters?, sources?, appExports?, resolveModule? }` into `{ ok, manifest, entrypoints, events, diagnostics }` or `{ ok: false, diagnostics }`. |
| `selectHandlerModules(files, discovery, appModule)`, `compileGlob(pattern)` | Handler module selection with host-independent glob semantics. |
| `discoverHandlers(modules)` | Handler registrations among evaluated modules' exports. |
| `serializeManifest`, `serializeEntrypoints`, `fingerprintManifest` | Canonical serialization and the manifest fingerprint. |
| `validateManifest`, `validateEntrypoints` | Readers for untrusted documents. |
| `manifestJsonSchema`, `entrypointsJsonSchema`, `manifestVersion`, `entrypointsFormat` | The formats. |
| `buildResourceGraph(manifest)` | The graph view. |
| `analyzeEvents`, `checkEventPolicies`, `analyzePublications`, `buildEventGraph`, `analyzeEventCycles`, `eventCycleDiagnostics`, `describeCyclePath` | The [event analysis](#event-analysis) steps, for hosts that run them separately. |
| `validateEventAnalysis(value)` | Reader for an untrusted event analysis, for example from another process. |
| `moduleEvaluationFailure(path, error)`, `sortDiagnostics`, `hasErrors` | Helpers for hosts. |

## Related

- [CLI reference](cli.md)
- [Compiler architecture](../architecture/compiler.md)
- [Schema contracts](schema-contracts.md)
- [Diagnostic codes](diagnostic-codes.md)
- [Security](../concepts/security.md#untrusted-build-time-execution)
