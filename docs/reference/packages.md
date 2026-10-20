# Packages

> **Status:** Reference for the current repository state. Nine framework packages, two integration packages and nine example packages (`package-smoke`, `schema-evolution`, `manifest`, `http-api`, `document-processing`, `order-pipeline`, `event-safety` and `observability` against the framework, `commerce` against the M0 experiments) exist; all are `"private": true` and unpublished. Other packages are planned.

All packages use the `@holqa/` npm scope, are ESM-only, ship bundled `.d.ts` declarations, and expose a single code entry point (`.`) through their `exports` map. `@holqa/compiler` additionally exports its JSON Schema files. Allowed dependencies are listed in [package boundaries](../architecture/package-boundaries.md).

## Summary

| Package | Path | Status | Purpose |
| --- | --- | --- | --- |
| `@holqa/core` | `packages/core` | **Implemented** (contracts) | Framework-neutral contracts: diagnostics, identity, descriptor protocol, resource and trigger registries, runtime binding. |
| `@holqa/compiler` | `packages/compiler` | **Implemented** (manifest pipeline, schema contracts) | Handler discovery, graph validation, manifest version 1, schema contracts and compatibility checks. |
| `@holqa/cli` | `packages/cli` | **Implemented** (help, version, `--json`, `inspect` with `--cycles` and `--capabilities`, `build --manifest`, `bindings inspect`, `bindings validate`, `dev`, `invoke`, `queue send`, `queue redrive`, `storage put`, `cron run`, `state`, `doctor`, `logs`, `traces list`, `traces inspect`, `events inspect`, `metrics`) | The `holqa` command-line interface and local development supervisor. |
| `@holqa/example-package-smoke` | `examples/package-smoke` | **Implemented** | Verifies built package outputs. |
| `@holqa/example-schema-evolution` | `examples/schema-evolution` | **Implemented** | End-to-end schema contract corpus with Zod. |
| `@holqa/example-manifest` | `examples/manifest` | **Implemented** | End-to-end compilation of SDK applications through the built CLI. |
| `@holqa/example-http-api` | `examples/http-api` | **Implemented** | An SDK application with routes, procedures and middleware, compiled by the built CLI and served by `@holqa/runtime-bun`. |
| `@holqa/example-document-processing` | `examples/document-processing` | **Implemented** | An event-driven SDK application (signed uploads, object events, a queue with retries and dead-lettering, a scheduled cleanup), compiled by the built CLI and run on `@holqa/local`. |
| `@holqa/example-order-pipeline` | `examples/order-pipeline` | **Implemented** | The local development example: run with `holqa dev`, tested end to end with `createTestApp` and with a real `holqa dev` session. |
| `@holqa/example-event-safety` | `examples/event-safety` | **Implemented** | Event safety: `holqa inspect --cycles` through the built CLI, runtime depth limits, an allowed cycle and idempotent processing with `createTestApp`. |
| `@holqa/example-observability` | `examples/observability` | **Implemented** | Observability: one correlated trace from an HTTP request through a queue to an object event, redacted logs, metrics, OTLP export to a stand-in collector, and the telemetry commands of the built CLI. |
| `@holqa/sdk` | `packages/sdk` | **Implemented** (application and resource model, HTTP routes, RPC procedures, middleware, queue, bucket and schedule operations) | Public developer-facing SDK. |
| `@holqa/runtime-bun` | `packages/runtime-bun` | **Implemented** (dispatcher, lifecycle, HTTP and RPC, queue, object event and schedule delivery, telemetry, `Bun.serve`) | Bun execution: invocation dispatcher, application lifecycle, HTTP, RPC and background transports. |
| `@holqa/bindings` | `packages/bindings` | **Implemented** (binding configurations, resolution, composition) | Selects a provider for every resource and service and composes them into one runtime binding. |
| `@holqa/conformance` | `packages/conformance` | **Implemented** (queue, bucket, object event and schedule suites) | Reusable provider conformance cases. |
| `@holqa/local` | `packages/local` | **Implemented** (local binding) | Local runtime drivers: SQLite-backed queues, filesystem object storage with events and signed URLs, a clock-driven scheduler, inspection, a local telemetry store. |
| `@holqa/testing` | `packages/testing` | **Implemented** (`createTestApp` with recording and replay, in-memory telemetry, type assertions) | Deterministic integration tests on the local environment, and compile-time type assertions. |
| `@holqa/client` | `packages/client` | Planned | Browser-safe generated-client runtime. |
| `@holqa/zod` | `packages/integrations/zod` | **Implemented** | Zod 4 schema adapter. |
| `@holqa/opentelemetry` | `packages/integrations/opentelemetry` | **Implemented** (OTLP/HTTP JSON export, `OTEL_*` variables) | OpenTelemetry interoperability without an OpenTelemetry SDK dependency. |
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
| `QueueBackoff`, `QueueBackoffStrategy`, `FixedQueueBackoff`, `ExponentialQueueBackoff`, `QueueSendOptions`, `QueueSendReceipt`, `backoffDelaySeconds(backoff, failedAttempt)`, `longestBackoffDelaySeconds(backoff)`, `queueBackoffProblem(value)`, `defaultQueueBackoff` | Types, functions, constant | Queue backoff requirements, send options (`delaySeconds`) and receipts (`messageId`), and the deterministic backoff computation. `QueueDriver.send(envelope, options)` receives the `holqa.message/1` envelope and returns a receipt. |
| `ObjectMetadata`, `ListObjectsOptions`, `ObjectList`, `SignedUrl`, `SignedUrlMethod`, `SignedUrlOptions`, `ObjectEventType` | Types | Bucket operations: `BucketDriver` has `put`, `get`, `head`, `delete`, `list` and `signUrl`; `BucketCapabilities` gains `events` and `signedUrls`. |
| `ObjectEvent`, `ObjectEventObject`, `objectEventFormat`, `objectEventTypes`, `readObjectEvent(value, subject)` | Types, constants, function | The portable `holqa.object-event/1` envelope and its structural reader (`HOLQA_PAYLOAD_MALFORMED`). |
| `checkObjectKey(key, operation)`, `maxObjectKeyBytes` | Function, constant | Portable object key rules (`HOLQA_OBJECT_KEY_INVALID`). |
| `parseCronSchedule(expression, timezone)`, `nextCronTime(schedule, after)`, `isTimeZone(value)`, `CronSchedule` | Functions, type | Cron evaluation in an IANA time zone with defined daylight-saving behaviour (`HOLQA_SCHEDULE_INVALID`). See [scheduled runs](runtime.md#scheduled-runs). |
| `ResourceSources`, `DeliverySource`, `LeasedDelivery`, `DeliveryTrace`, `ReceiveRequest`, `DeliveryFailure`, `QueueSource`, `ObjectEventSource`, `ObjectEventSubscription`, `ScheduleSource`, `ScheduleListener`, `ScheduleTick`, `ScheduleRunResult` (`SucceededScheduleRun`, `FailedScheduleRun`, `SkippedScheduleRun`), `ScheduleRunStatus`, `ScheduleSubscription` | Types | The consuming half of a binding: `RuntimeBinding.sources` ([ADR 0024](../architecture/decisions/0024-event-delivery-sources-and-local-drivers.md)). `DeliverySource.extend` (optional) renews a lease. `LeasedDelivery.trace` (optional) is the sender's trace. |
| `DriverOperationContext` | Type | `{ trace? }`, the optional last argument of `QueueDriver.send`, `BucketDriver.put` and `BucketDriver.delete`: the trace of the invocation performing the operation, which drivers may store with deliveries. |
| `TriggerKindMap`, `TriggerKind`, `triggerKinds`, `isTriggerKind`, `resourceKindOfTrigger` | Types, constant, functions | The trigger kind registry (`queue.message`, `bucket.object-created`, `bucket.object-deleted`, `schedule.tick`, `http.route`, `http.procedure`). Metadata types: `QueueMessageMetadata` (`attempt`, `messageId`, `schemaVersion?`), `ObjectEventMetadata` (`eventId`, `eventTime`, `attempt`), `ScheduleTickMetadata` (`scheduledTime`, `runId?`, `trigger?`). |
| `HandlerDefinition`, `Trigger`, `ResourceReference`, `InvocationContext`, `HandlerInvoke` | Types | Handler metadata (JSON) and the executable `invoke` contract. |
| `RuntimeBinding`, `BindingCapabilities`, `ResourceDrivers`, `BindingSlot`, `createBindingSlot` | Types, function | The data-plane binding contract. `RuntimeBinding.describe(resource)` (optional) reports the provider and capabilities selected for one resource. |
| `ResourceBindingInfo`, `resourceBindingInfo(binding, resource)` | Type, function | The provider name and capabilities that apply to one resource: `describe`'s answer, or the binding's own. |
| `requiredCapabilities(resource)`, `providedCapabilities(kind, capabilities)`, `CapabilitySubject` | Functions, type | The required-capability vocabulary for both sides of capability negotiation. `QueueCapabilities.maxMessageBytes` limits each send. |
| `bindingContracts`, `bindingContractNames`, `BindingContractName`, `bindingProtocolVersion`, `BindingProtocolVersion`, `mandatoryBindingContracts`, `isBindingContractName`, `contractVersionProblem` | Constants, types, functions | Versioned binding contracts and the exact-version compatibility check. See [binding contracts](bindings.md). |
| `BindingProvider<Kinds, Services>`, `AnyBindingProvider`, `ProviderRole`, `BindingServiceName`, `ProviderContext`, `ProviderInstance`, `ConfigSource`, `ExecutionCapabilities`, `CapabilityEmulation`, `ProviderTopology`, `CredentialReference` | Types | The provider protocol. |
| `isBindingProvider(value)`, `isProviderId(value)`, `credentialRef(name)`, `isCredentialReference(value)`, `validateProvider(value)` | Functions | Recognize and validate providers; create credential references (`HOLQA_BINDING_CONFIG_INVALID` for an invalid name). |
| `bindingFailure(kind, init)`, `bindingFailureCodes`, `BindingFailureKind`, `BindingFailureInit`, `isTransientBindingFailure(diagnostic)` | Functions, constant, types | Classified binding failures, one code per kind. |
| `BindingLifecycle`, `BindingHealth`, `ComponentHealth`, `HealthStatus`, `BindingStartOptions`, `BindingStopOptions`, `BindingLogLevel`, `combineHealth(components)` | Types, function | The binding lifecycle and health reports. |
| `bindApp(app, binding)` | Function | Installs a binding after checking capabilities and drivers; returns an unbind function. Throws `HOLQA_RUNTIME_ALREADY_BOUND` or `HOLQA_BINDING_CAPABILITY_UNSUPPORTED`. |
| `requireBinding`, `resolveDriver`, `readConfig` | Functions | Resolve the current binding, a resource's driver or a configuration value; throw `HOLQA_RUNTIME_NOT_BOUND` without a binding. |
| `checkCapabilities(resource, advertised, bindingName)` | Function | Compares a resource's requirements with the capabilities a binding advertises for its kind; one `HOLQA_BINDING_CAPABILITY_UNSUPPORTED` diagnostic per shortfall. |
| `checkTriggerDelivery(app, handlers, binding)`, `DeliveredHandler` | Function, type | Reports handlers whose trigger a binding cannot deliver: no source for the kind, an object event type it does not advertise, or redelivery delays of the default backoff beyond its `maxDelaySeconds`. |
| `HttpMethod`, `HttpRouteTriggerOptions`, `HttpRouteTriggerSchemas`, `HttpProcedureOperation`, `HttpProcedureTriggerOptions`, `HttpProcedureTriggerSchemas` | Types | The `http.route` trigger (with an optional `headers` schema) and the `http.procedure` trigger (`{ operation: "query" \| "mutation" }`, schemas `input?`, `output`). |
| `HttpInvocationInput`, `isHttpInvocationInput(value)`, `isResponseLike(value)` | Type, functions | What runtimes pass to HTTP handlers' `invoke` (`{ request, params }`), and structural guards for requests and responses. |
| `httpEndpoint(basePath, definition)`, `httpRouteKeys(basePath, definition)`, `joinRoutePath`, `routeShape`, `HttpEndpoint` | Functions, type | Where an HTTP handler is served and the `<METHOD> <shape>` keys the compiler and runtime use for `HOLQA_ROUTE_CONFLICT`. |
| `HttpRejectedError`, `HttpRejectedErrorInit`, `isHttpRejectedError(value)` | Class, type, function | Rejects a request with an explicit status, safe message and headers (`HOLQA_HTTP_REJECTED`, or the code of a Holqa error `cause`). |
| `HttpErrorBody`, `HttpErrorDetail` | Types | The error body sent to HTTP and RPC callers: `{ error: { code, message, invocationId?, issues? } }`. |
| `rpcProtocolFormat`, `rpcProtocolVersion`, `rpcVersionHeader`, `rpcMountSegment`, `rpcInputQueryParameter`, `rpcProcedurePath(basePath, id)` | Constants, function | The `holqa.rpc/1` protocol: `"holqa.rpc/1"`, `"1"`, `"holqa-rpc-version"`, `"rpc"`, `"input"`, and `<basePath>/rpc/<id>`. |
| `RpcRequestEnvelope`, `RpcSuccessEnvelope`, `RpcFailureEnvelope`, `RpcResponseEnvelope` | Types | The RPC request and response envelopes. |
| `ApplicationScope`, `ScopedDefinition` | Types | The application execution context: values created once per runtime and disposed of when it stops. `InvocationContext` gains optional `correlationId` and `scope`. |
| `DeliveryTrace`, `InvocationLineage`, `lineageOfDelivery(trace, fallbackRootId)`, `childTrace(lineage, invocationId)` | Types, functions | Event lineage: traces carry `correlationId`, `causationId`, `rootId` and `depth`; `InvocationContext.lineage` and `LeasedDelivery.sentAt` are optional. See [event safety](../concepts/event-safety.md#event-lineage). |
| `HandlerEventPolicy`, `HandlerCycleAllowance`, `HandlerIdempotencyPolicy`, `IdempotencyKeySource`, `eventPolicyProblems(value)`, `idempotencyPolicyProblems(value)`, `defaultEventLimits`, `maxCycleJustificationLength`, `isEventGuardCode(code)` | Types, functions, constants | The `events` and `idempotency` fields of handler definitions, their structural checks, the default limits (`{ maxDepth: 16, maxPublications: 1000 }`) and the codes whose deliveries end terminally. |
| `OperationBudgetStore`, `OperationBudgetRequest`, `OperationBudgetResult` | Types | Atomic per-operation accounting a binding provides as `RuntimeBinding.operationBudgets`. |
| `TraceContext`, `parseTraceparent(value, traceState?)`, `formatTraceparent(context)`, `isTraceId`, `isSpanId`, `randomTraceId()`, `randomSpanId()`, `traceparentHeader`, `tracestateHeader` | Type, functions, constants | W3C Trace Context. `parseTraceparent` reads version 00 with exactly four fields and later versions by their first four fields; version `ff` is invalid. `DeliveryTrace` gains an optional `traceparent`; `childTrace(lineage, invocationId, traceparent?)` passes it on. |
| `TelemetryExporter`, `TelemetryResource`, `SpanRecord`, `SpanKind`, `SpanStatus`, `SpanLink`, `SpanEvent`, `MetricRecord` (`SumMetricRecord`, `HistogramMetricRecord`, `GaugeMetricRecord`), `SumPoint`, `HistogramPoint`, `GaugePoint`, `TelemetryLogRecord`, `TelemetryLogSeverity`, `TelemetryAttributes`, `TelemetryAttributeValue`, `TelemetryExportOptions` | Types | The telemetry data model, close to OpenTelemetry's, and the exporter contract; export calls receive a `signal` that aborts when they exceed the runtime's export time limit, and exporters should work asynchronously. `SpanStatus` is a union; only `code: "error"` carries a `message`. See [observability](../concepts/observability.md). |
| `frameworkMetrics`, `FrameworkMetric`, `FrameworkMetricType`, `metricOverflowAttribute` | Constant, types | The framework metrics with their units and allowed attributes (names are literal types); `"otel.metric.overflow"`. |
| `createRedactor(options?)`, `Redactor`, `RedactorOptions`, `defaultSensitiveKeys`, `defaultSensitiveKeySuffixes`, `redactedValue`, `minRedactedValueLength` | Function, types, constants | Redaction of sensitive field names (`defaultSensitiveKeys` match anywhere in the normalized name, `defaultSensitiveKeySuffixes` only at its end, extra `keys` anywhere) and known secret values in text, JSON and attributes. |
| `InvocationTelemetry` | Type | `InvocationContext.telemetry` (optional): `{ traceId, spanId, sampled, traceparent }`. `InvocationLogger` gains a required `debug`. `QueueSource.pending` (optional) counts a queue's backlog. |
| `IdempotencyStore`, `IdempotencyClaim`, `IdempotencyBeginOptions`, `IdempotencyCompleteOptions`, `IdempotencyExtendOptions`, `createIdempotencyKey(parts)`, `createMemoryIdempotencyStore(options?)`, `MemoryIdempotencyStoreOptions` | Types, functions | The deduplication store a binding provides as `RuntimeBinding.idempotency`, the key convention, and a single-process in-memory store. |

Resource identifier grammar: `^[a-z][a-z0-9]*(?:[-.][a-z0-9]+)*$`, 1–63 characters (for example `order-processing`, `orders.process`). The grammar is an initial proposal and may be revised before 1.0 ([ADR 0004](../architecture/decisions/0004-stable-logical-resource-identities.md)).

## `@holqa/sdk`

- **Path:** `packages/sdk`
- **Status:** Implemented (application and resource model, HTTP routes, RPC procedures, middleware, scoped values, queue, bucket and schedule operations). Private. `staticSite` is proposed.
- **Purpose:** Declare applications, resources, configuration and handlers with types inferred from source. Runtime-neutral.
- **Entry point:** `@holqa/sdk` → `dist/index.js`, `dist/index.d.ts`.
- **Internal dependencies:** `@holqa/core`.

| Export | Kind | Description |
| --- | --- | --- |
| `defineApp(definition)` | Function | Validates and defines an application; returns `{ name, resources, env, "~holqa" }`. See [application model](../concepts/application-model.md). |
| `defineResources(group)`, `composeResources(...groups)` | Functions | Typed resource groups for registries split across modules; `composeResources` rejects duplicate aliases. |
| `queue`, `bucket`, `schedule`, `http.api` | Functions | Resource factories returning typed handles. Queues accept `delivery: { maxAttempts?, deadLetter?, backoff? }`; `send(message, { delaySeconds? })` resolves to `{ messageId }`. Buckets have `put`, `get`, `head`, `delete`, `list`, `signedUrl`, `onObjectCreated` and `onObjectDeleted`; the object event schemas implement Standard JSON Schema (vendor `holqa`), so compilers can record them. Schedules validate their cron expression at declaration. See the [runtime reference](runtime.md#queue-delivery). |
| `secret(schema)`, `variable(schema, { default? })` | Functions | Configuration entries. |
| `App`, `AppDefinition`, `ConfigValues`, `HandlerDiscoveryOptions` | Types | Application types. |
| `QueueHandle`, `BucketHandle`, `ScheduleHandle`, `HttpApiHandle`, `ResourceHandle`, `AnyResource`, `ResourceRecord` | Types | Handle types. |
| `QueueConsumer`, `ObjectCreatedHandler`, `ObjectDeletedHandler`, `ScheduleHandler`, `HandlerRegistration` | Types | Handler registrations. |
| `ObjectCreatedContext`, `ObjectDeletedContext`, `ObjectCreatedOptions`, `ObjectDeletedOptions`, `ObjectInfo`, `DeletedObjectInfo`, `ObjectEventInfo`, `ScheduleContext` | Types | Handler contexts: object handlers receive `event: { id, time, attempt }`; schedule handlers receive `trigger` and `runId`. |
| `QueueMessageInput`, `QueueMessageOutput`, `QueueConsumerFor`, `ResourceIdOf`, `ResourceIds`, `ResourceById`, `ResourceAliasesOfKind` | Types | Type helpers derived from handles. |
| `HandlerEventOptions`, `PublishableResource`, `IdempotencyOptions`, `QueueIdempotencyContext`, `ObjectEventIdempotencyContext` | Types | Every handler registration accepts `events: { publishes?, cycle?, maxPublications?, maxDepth? }`; queue consumers and object event handlers also accept `idempotency: true \| { key?, retentionSeconds?, leaseSeconds? }`. Queue, object event and schedule contexts gain `lineage`. See [event safety](../concepts/event-safety.md). |
| (contexts) | — | Route, procedure, middleware, queue, object event and schedule handler arguments include an optional `telemetry` (`traceId`, `spanId`, `sampled`, `traceparent`) and a logger with `debug`. See [observability](../concepts/observability.md). |
| `HolqaTypeError`, `CheckResourceId`, `CheckUniqueResourceIds`, `DuplicateResourceIds`, `ResourceIdProblem`, `CheckDistinctAliases` | Types | Compile-time declaration checks. |
| `HttpApiHandle.route(options)` | Method | Registers an HTTP route: `{ id, method, path, params?, query?, headers?, body?, responses, middleware?, handler }`. See the [runtime reference](runtime.md#http-routes). |
| `HttpApiHandle.procedure(options)` | Method | Registers an RPC procedure: `{ id, operation, input?, output, middleware?, handler }`, served at `<basePath>/rpc/<id>`. See [RPC procedures](runtime.md#rpc-procedures). |
| `middleware(options)`, `middleware.requires<Context>()` | Functions | Typed HTTP middleware for `defineApp`, `http.api`, routes and procedures. See [middleware](runtime.md#middleware). |
| `scoped({ name, create, dispose? })` | Function | Declares an application-scoped value used with `scope.use(definition)`. |
| `HttpRoute`, `RouteOptions`, `RouteContext`, `RouteContract`, `InferRouteContract`, `RouteReply`, `RouteReplyValue`, `RouteResult`, `ResponseSchemas`, `PathParams`, `PathParamNames`, `CheckParams`, `BodylessMethod`, `QueryRecord`, `HeaderRecord` | Types | Route registrations, handler contexts and client contracts. |
| `HttpProcedure`, `ProcedureOptions`, `ProcedureContext`, `ProcedureContract`, `InferProcedureContract` | Types | Procedure registrations and client contracts. |
| `HttpMiddleware`, `AnyHttpMiddleware`, `MiddlewareOptions`, `MiddlewareArgs`, `MiddlewareNext`, `MiddlewareResult`, `MiddlewareReturn`, `MiddlewareFactory`, `DefineMiddleware`, `MiddlewareChainContext`, `CheckMiddlewareChain`, `MiddlewareExtension`, `MiddlewareRequirement`, `ExtendContext`, `AppResources`, `ScopedOptions` | Types | Middleware typing and the application's resource types with middleware context. `HttpApiOptions` gains `middleware`; `App` gains a third type parameter (the application middleware's context, default `{}`). |

## `@holqa/runtime-bun`

- **Path:** `packages/runtime-bun`
- **Status:** Implemented (dispatcher, lifecycle, HTTP routes, RPC procedures, queue, object event and schedule delivery, trace and lineage propagation, event limits, telemetry, `Bun.serve` adapter, versioned handler registry with in-place replacement). Private. Worker isolation and module unloading are planned. See the [runtime reference](runtime.md), [ADR 0028](../architecture/decisions/0028-hot-handler-replacement.md), [ADR 0023](../architecture/decisions/0023-common-invocation-engine-and-http-rpc-execution.md) and [ADR 0024](../architecture/decisions/0024-event-delivery-sources-and-local-drivers.md).
- **Entry point:** `@holqa/runtime-bun` → `dist/index.js`, `dist/index.d.ts`. Requires Bun (`engines.bun >= 1.3.13`) for `serve` and `loadCompiledApplication`.
- **Internal dependencies:** `@holqa/core`.

| Export | Kind | Description |
| --- | --- | --- |
| `createRuntime(options)` | Function | Validates an application and its handlers and returns a `Runtime`: `start`, `stop`, `invoke`, `fetch`, `stats`, `telemetry`, `replaceHandlers`, `handlerVersions`, `health`, `state`, `name`, `handlers`. `start` starts the binding's lifecycle when it has one, then consumes the binding's sources to deliver queue messages, object events and scheduled runs, and fails when the binding cannot deliver a handler's trigger unless `manualTriggers: true`. |
| `Runtime`, `RuntimeOptions`, `RuntimeLimits`, `RuntimeHttpOptions`, `RuntimeDeliveryOptions`, `RuntimeState`, `RuntimeStats`, `StopOptions` | Types | The runtime and its settings. `RuntimeStats.delivery` (`TransportStats`, `DeliveryStats`) counts received, acknowledged, retried, dead-lettered, discarded, blocked (ended by an event limit) and released deliveries and scheduled runs. |
| `RuntimeHealth` | Type | `runtime.health()`: `status`, `state`, `ready` and the runtime's and binding's `components`. See [binding lifecycle and health](runtime.md#binding-lifecycle-and-health). |
| `HandlerReplacement`, `ReplaceHandlersOptions`, `HandlerVersionInfo`, `HandlerRegistryStats` | Types | In-place handler replacement: the result of `replaceHandlers`, its `sources` option, the entries of `handlerVersions()` and `RuntimeStats.versions`. See [handler versions](runtime.md#handler-versions). |
| `RuntimeEventLimits`, `EventGuardViolation` | Types | `RuntimeOptions.events` (`maxDepth`, `maxPublications`, `maxEventAgeMs`, `maxEventsPerOperation`) and the refusal recorded as `blocked` on outcomes. See [event lineage and limits](runtime.md#event-lineage-and-limits). |
| `InvocationRequest`, `InvocationOutcome`, `InvocationSuccess`, `InvocationFailed`, `InvocationFailure`, `DispatchStats` | Types | Normalized invocations (with optional `causationId`, `rootId` and `depth`) and their structured outcomes (with `emitted`, `lineage` and `blocked`). |
| `EmittedEvent`, `EmittedQueueMessage`, `EmittedObjectChange` | Types | What an invocation emitted: sent messages and created or deleted objects. |
| `serve(runtime, options)`, `ServeOptions`, `RunningServer`, `stopOnSignals(server, options?, signals?)` | Functions, types | Serves a runtime with `Bun.serve` (default `127.0.0.1:3000`, 1 MiB bodies) and stops gracefully on signals. |
| `loadCompiledApplication({ root, buildDir? })`, `LoadCompiledApplicationOptions`, `CompiledApplication` | Function, types | Loads `holqa build --manifest` output and checks it against the code (`HOLQA_BUILD_STALE`); `handlerSources` names each handler's `<module>#<export>`. |
| `createEnvironmentBinding(app, env)`, `EnvironmentVariables` | Function, type | The default binding: `http.api` capability and validated configuration from environment variables. |
| `CorsOptions` | Type | The CORS policy. |
| `correlationHeader` | Constant | `"x-correlation-id"`. |
| `jsonLineSink(write?)`, `silentSink`, `LogSink`, `LogEntry`, `LogLevel` | Functions, types | Structured log sinks. `RuntimeOptions.logLevel` filters by level; `RuntimeOptions.redact` adds redacted field names. |
| `RuntimeTelemetryOptions`, `MessageTraceRelation`, `TelemetryIdGenerator`, `TelemetryStats`, `RuntimeTelemetryControl`, `PipelineLimits` | Types | `RuntimeOptions.telemetry`, `runtime.telemetry` (`enabled`, `flush`), `RuntimeStats.telemetry` and `StopOptions.telemetryMs`. See [telemetry](runtime.md#telemetry). |

## `@holqa/bindings`

- **Path:** `packages/bindings`
- **Status:** Implemented (binding configurations, resolution, composition). Private. See [binding contracts](bindings.md#binding-configurations) and [ADR 0030](../architecture/decisions/0030-binding-composition-and-resolution.md).
- **Entry point:** `@holqa/bindings` → `dist/index.js`, `dist/index.d.ts`. Runtime-neutral.
- **Internal dependencies:** `@holqa/core`.

| Export | Kind | Description |
| --- | --- | --- |
| `defineBindings(app, config)`, `isBindingsDefinition(value)` | Functions | Declares which provider fulfils each resource (by identifier), resource kind and service; pure and type-checked against the application. `HOLQA_APP_INVALID`, `HOLQA_BINDING_CONFIG_INVALID`. |
| `BindingsConfig`, `BindingsDefinition`, `BindableApp`, `ResourceBindings`, `KindBindings`, `ServiceBindings`, `ServiceSelection`, `CheckBindings`, `BindingsTypeError`, `ResourceIdsOf`, `ResourceKindsOf`, `KindOfResource` | Types | The configuration and its compile-time checks. |
| `resolveBindings(definition)`, `assertResolved(resolved)` | Functions | Deterministic resolution (resource, kind, default) and service selection, reporting `HOLQA_BINDING_RESOURCE_UNKNOWN`, `HOLQA_BINDING_KIND_MISMATCH`, `HOLQA_BINDING_MISSING` and provider validation problems. |
| `ResolvedBindings`, `ResourceSelection`, `ResourceSelectionSource`, `ServiceSelectionResult`, `ServiceSelectionSource` | Types | Resolution results. |
| `createBinding(resolved)` | Function | Composes a resolution into one `RuntimeBinding` with a lifecycle. |
| `environmentConfig(options?)`, `EnvironmentConfigOptions`, `EnvironmentVariables` | Function, types | The configuration service provider for environment variables; the built-in fallback. |
| `validateBindings(resolved, options?)`, `BindingValidationOptions`, `ValidatedHandler` | Function, types | Validates a resolution without opening providers: requirements, trigger delivery, topology (`HOLQA_BINDING_TOPOLOGY_UNSUPPORTED`), execution limits and event safety stores. |
| `inspectBindings(resolved, options?)`, `bindingReportFormat`, `BindingReport`, `ResourceReport`, `RequirementReport`, `CapabilitySupport`, `ServiceReport`, `ProviderReport` | Function, constant, types | The `holqa.bindings/1` report: providers, selections and native, emulated or unsupported requirements. |

## `@holqa/conformance`

- **Path:** `packages/conformance`
- **Status:** Implemented (queue, bucket, object event and schedule suites). Private. See [conformance](bindings.md#conformance).
- **Entry point:** `@holqa/conformance` → `dist/index.js`, `dist/index.d.ts`. Runtime-neutral and test-runner-neutral.
- **Internal dependencies:** `@holqa/core`.

| Export | Kind | Description |
| --- | --- | --- |
| `queueConformance`, `bucketConformance`, `bucketEventsConformance`, `scheduleConformance` | Constants | The normative cases of each contract. |
| `QueueHarness`, `QueueFixture`, `BucketHarness`, `BucketFixture`, `ScheduleHarness`, `ScheduleFixture`, `ConformanceTime` | Types | What a provider supplies to run them. |
| `runConformance(suite, harness)`, `registerConformance(suite, harness, runner, timeoutMs?)`, `ConformanceResult`, `ConformanceSuite`, `ConformanceCase`, `TestRunner` | Functions, types | Run a suite directly, or register it with a test runner. |
| `ConformanceFailure`, `ConformanceSkip`, `expectThat`, `expectEqual`, `deepEqual`, `eventually` | Classes, functions | Assertions for writing cases. |

## `@holqa/local`

- **Path:** `packages/local`
- **Status:** Implemented (local binding). Private. See the [local environment reference](local.md).
- **Purpose:** Fulfils queues, buckets and schedules on one machine with the same driver and source contracts as any binding.
- **Entry point:** `@holqa/local` → `dist/index.js`, `dist/index.d.ts`. Requires Bun (`bun:sqlite`).
- **Internal dependencies:** `@holqa/core`, `@holqa/runtime-bun`.

| Export | Kind | Description |
| --- | --- | --- |
| `createLocalEnvironment(options)`, `LocalEnvironment`, `LocalEnvironmentOptions`, `SettleOptions` | Function, types | Creates `{ binding, clock, queues, storage, scheduler, settle, close }` over a state directory. The binding provides `operationBudgets` and `idempotency`, kept in the state database. |
| `local` (`platform`, `queues`, `buckets`, `schedules`, `environment`), `localEnvironment(options?)`, `LocalBindingOptions`, `LocalPersistence`, `LocalProviders`, `OpenedLocalState` | Constant, function, types | The local binding providers, with `sqlite` or `memory` persistence, sharing one state per environment. See [binding providers](local.md#binding-providers). |
| `openLocalState(app, options)`, `LocalState`, `LocalStateOptions` | Function, types | The engine both `createLocalEnvironment` and the providers run on. |
| `Clock`, `systemClock`, `ManualClock` | Type, constant, class | The injectable time source; `ManualClock` has `advance(ms)`, `jump(ms)` and `nextTimerDue()`. |
| `LocalQueues`, `LocalQueueMessage`, `LocalMessageState`, `RedriveOptions` | Types | Queue inspection: `messages` (with the sender's `trace` and lineage), `deadLetters`, `redrive` (all, one, or `{ messageId?, limit?, newOperation? }`), `duplicate`, `purge`. |
| `LocalStorage`, `LocalObjectEvent` | Types | Object and event inspection (`objects`, `events` with `trace` and per-delivery `visibleAt`, `redriveEvents`, `duplicateEvent`), `retainSubscriptions`, and signed URL serving (`fetch`, `handles`). |
| `LocalScheduler`, `LocalScheduleRun`, `LocalRunStatus` | Types | Manual runs (`trigger`), run records (`runs`), `nextRun`, `idle`. |
| `DeliveryState`, `DeliveryError`, `stateVersion`, `stateFileName`, `readStateFormat(directory)` | Types, constants, function | The state format (version 4, `state.sqlite`; versions 1 to 3 are upgraded in place). Queue sources implement `pending`. |
| `readDeliveryHistory(directory, id)`, `DeliveryHistory`, `DeliveryRecord`, `ObjectEventSummary` | Function, types | Read-only history of one message or object event. |
| `createLocalTelemetryStore(options)`, `openLocalTelemetryReader(directory)`, `LocalTelemetryStore`, `LocalTelemetryReader`, `LocalTelemetryStoreOptions`, `TelemetryRetention`, `LogQuery`, `StoredLogEntry`, `TraceSummary`, `telemetryFileName`, `telemetryStoreVersion` | Functions, types, constants | The local telemetry store (`telemetry.sqlite`). See [telemetry store](local.md#telemetry-store). |
| `manualTriggerMetadata(app, definition, options)`, `ManualTriggerOptions` | Function, type | The trusted metadata for invoking a queue, object event or schedule handler directly. |

## `@holqa/testing`

- **Path:** `packages/testing`
- **Status:** Implemented (`createTestApp` with recording, replay and causal chains, type assertions). Private. See the [local development guide](../guides/local-development.md).
- **Entry point:** `@holqa/testing` → `dist/index.js`, `dist/index.d.ts`. `createTestApp` requires Bun; it loads `@holqa/local` only when called, so the type assertions import nothing Bun-specific.
- **Internal dependencies:** `@holqa/core`, `@holqa/sdk`, `@holqa/local`, `@holqa/runtime-bun`.

| Export | Kind | Description |
| --- | --- | --- |
| `createTestApp(options)`, `TestApp`, `TestAppOptions`, `TestInvokeOptions`, `DrainOptions`, `InvocationFilter`, `RecordingOptions`, `ReplayOptions` | Function, types | Starts an application on a runtime and a local environment with a temporary state directory and a virtual clock: `fetch`, `invoke`, `send`, `put`, `trigger`, `flush`, `advance`, `drain`, `failNext`, `duplicate`, `duplicateEvent`, `redrive`, inspection (`messages`, `deadLetters`, `events`, `objects`, `read`, `runs`), `logs`, `invocations`, `trace`, `lineage`, `operation`, `recording`, `replay`, `chain`, `telemetry`, `flushTelemetry`, `dispose`. Telemetry is recorded in memory with deterministic identifiers; `telemetry`, `logLevel` and `redact` options pass through to the runtime. `events` sets the runtime's event limits; `maxInvocations` (default 10 000) bounds the work a test runs (`HOLQA_SIMULATION_BUDGET_EXCEEDED`). |
| `FailureOptions` | Type | `{ times?, error?, when? }` for `failNext`. |
| `Recording`, `RecordedInvocation`, `ChainStep`, `recordingFormat` | Types, constant | `holqa.recording/1` documents: what each handler received (JSON input, trigger metadata, lineage, `replayable`), redacted like logs unless `sanitize: false`; and the steps `chain(rootId)` returns. See [record and replay](../guides/local-development.md#record-and-replay). |
| `invocationRecords(entries)`, `InvocationRecord` | Function, type | Reads finished invocations (trigger, attempt, outcome, code, `causationId`, `rootId`, `depth`, `emitted`, `blocked`) from runtime log entries. |
| `lineageOf(records, invocationId)` | Function | The chain of records from an invocation back to its root, root first. |
| `createMemoryTelemetry()`, `MemoryTelemetry`, `SpanFilter` | Function, types | An exporter that records in memory, with `spans(filter?)`, `trace(traceId)`, `logs()`, `metrics()`, `metric(name, attributes?)`, `resource()` and `clear()`. |
| `spanTree(spans)`, `SpanNode` | Function, type | Spans as trees of `{ name, kind, status, children }`, for asserting causal structure. |
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
| `compileApplication(input)` | Function | Compiles `{ app, appModule, modules, runtime, adapters?, sources?, appExports?, resolveModule? }` into `{ ok: true, manifest, entrypoints, events, diagnostics }` or `{ ok: false, diagnostics }`. Collects every problem. |
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
| `EventAnalysis`, `analyzeEvents(input)`, `checkEventPolicies(handlers, resources)`, `AnalyzeEventsInput`, `AnalyzedHandler` | Types, functions | The [event analysis](compiler-specification.md#event-analysis): the event dependency graph and its cycles. |
| `buildEventGraph(manifest, publications, facts?)`, `EventGraph`, `EventGraphNode`, `EventGraphResourceNode`, `EventGraphHandlerNode`, `EventGraphEdge`, `ConsumptionEdge`, `PublicationEdge`, `ConsumedEvent`, `EventPublication`, `PublicationTarget`, `PublicationOperation`, `PublicationCertainty`, `PublicationOrigin`, `HandlerAnalysisCoverage`, `HandlerEventFacts` | Function, types | The event dependency graph. |
| `analyzePublications(input)`, `PublicationAnalysisInput`, `HandlerToAnalyze`, `HandlerPublications`, `ModuleResolver`, `ResolvedModule` | Function, types | Static analysis of what handlers publish. |
| `analyzeEventCycles(graph)`, `eventCycleDiagnostics(cycles, graph)`, `describeCyclePath(path)`, `EventCycle`, `EventCycleStep`, `CycleAllowance` | Functions, types | Cycle detection (strongly connected components), `HOLQA_EVENT_CYCLE` diagnostics and path rendering. |
| `validateEventAnalysis(value)` | Function | Reader for an untrusted event analysis (`HOLQA_ANALYSIS_FAILED`). |
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

## `@holqa/opentelemetry`

- **Path:** `packages/integrations/opentelemetry`
- **Status:** Implemented (OTLP/HTTP JSON export, `OTEL_*` environment variables). Private. An `@opentelemetry/api` bridge and OTLP over protobuf or gRPC are planned. See the [package README](../../packages/integrations/opentelemetry/README.md).
- **Purpose:** Sends Holqa telemetry to any OTLP/HTTP receiver. Uses only the Fetch API; no OpenTelemetry package is a dependency.
- **Entry point:** `@holqa/opentelemetry` → `dist/index.js`, `dist/index.d.ts`.
- **Internal dependencies:** `@holqa/core`.

| Export | Kind | Description |
| --- | --- | --- |
| `createOtlpHttpExporter(options?)`, `OtlpHttpExporterOptions`, `OtlpSignals` | Function, types | A `TelemetryExporter` named `otlp-http` posting to `<endpoint>/v1/traces`, `/v1/metrics` and `/v1/logs` (default endpoint `http://localhost:4318`, time limit 10 000 ms, no retries). |
| `readOtelEnvironment(env)`, `OtelEnvironment`, `OtelEnvironmentSettings` | Function, types | Reads the standard `OTEL_*` variables into exporter options, service name, resource attributes, sample ratio and log export; returns `HOLQA_TELEMETRY_CONFIG_INVALID` problems for unsupported values. |
| `encodeOtlpTraces`, `encodeOtlpMetrics`, `encodeOtlpLogs`, `toAnyValue`, `toKeyValues`, `toUnixNano`, `otlpScope`, `OtlpAnyValue`, `OtlpKeyValue` | Functions, constant, types | The OTLP/JSON encoding, for custom transports. |

## `@holqa/cli`

- **Path:** `packages/cli`
- **Status:** Implemented (help, version, `--json`, `inspect` with `--cycles`, `build --manifest`, `dev`, `invoke`, `queue send`, `queue redrive`, `storage put`, `cron run`, `state`, `doctor`, `logs`, `traces list`, `traces inspect`, `events inspect`, `metrics`). Private. Bundling and `openapi generate` are proposed. See [CLI reference](cli.md).
- **Purpose:** Holqa developer CLI and local development supervisor.
- **Entry points:** library `@holqa/cli` → `dist/index.js`; binary `holqa` → `dist/bin.js`; analysis process entry `dist/analyze.js` and generation process entry `dist/generation.js` (internal, spawned by the CLI). Runs on Bun, `engines.bun >= 1.3.13`.
- **Internal dependencies:** `@holqa/core`, `@holqa/compiler`, `@holqa/local`, `@holqa/runtime-bun`, `@holqa/opentelemetry`.

| Export | Kind | Description |
| --- | --- | --- |
| `runCli(argv, io, version, host?)` | Function | Runs the CLI against split arguments; writes through `io`; resolves to an exit code. `host` defaults to `createProcessHost()`. |
| `CliIo` | Type | `{ stdout(text), stderr(text) }`. |
| `CliHost`, `AnalysisOutcome`, `AnalysisSuccess`, `AnalysisFailure` | Types | Working directory, analysis and file writing, injected for tests; optional `readFile`, `dev`, `operate` and `doctor` for the local commands, and `telemetry`, `deliveryHistory` and `waitForStop` for the telemetry commands. `AnalysisSuccess.events` (optional) carries the event analysis `inspect --cycles` prints. |
| `DevEvent`, `ApplicationSummary`, `ResourceSummary`, `HandlerSummary`, `ManifestChange`, `ChangeKind`, `IdentityChanges` | Types | The events of a `holqa dev` session (its `--json` lines) and the classification of a rebuild. |
| `DevRequest`, `DoctorRequest`, `DoctorCheck`, `AppLocation`, `LocalOperation`, `OperationResponse`, `OperateOutcome`, `OperationTarget`, `PhaseResult` | Types | Requests and results of the local commands. |
| `createProcessHost(options?)`, `ProcessHostOptions`, `forwardedEnvironment` | Function, type, constant | The default host: analysis in a separate Bun process with an allowlisted environment, `--no-install` and a timeout; the local commands run the application in generation processes with the CLI's environment. |
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

## `@holqa/example-http-api`

- **Path:** `examples/http-api`
- **Status:** Implemented. Private; not published.
- **Purpose:** The runtime acceptance test: an SDK application with routes, RPC procedures, application and route middleware and a scoped store, compiled by the built `holqa` binary, loaded with `loadCompiledApplication` and served with `serve` on a loopback port. See its [README](../../examples/http-api/README.md).

## `@holqa/example-document-processing`

- **Path:** `examples/document-processing`
- **Status:** Implemented. Private; not published.
- **Purpose:** The acceptance test of event-driven resources: an HTTP upload through a signed URL, an object-created event, a queued job, a background processor with retries and dead-lettering, and an hourly cleanup, compiled by the built `holqa` binary and run on `@holqa/local` with a manual clock. See its [README](../../examples/document-processing/README.md).

## `@holqa/example-order-pipeline`

- **Path:** `examples/order-pipeline`
- **Status:** Implemented. Private; not published.
- **Purpose:** The local development example: an order pipeline (HTTP, a queue with retries and dead-lettering, uploads with object events, an hourly schedule) started with `holqa dev`, tested with `createTestApp` under controlled failures, and exercised through a real `holqa dev` session and the operation commands. See its [README](../../examples/order-pipeline/README.md).

## `@holqa/example-event-safety`

- **Path:** `examples/event-safety`
- **Status:** Implemented. Private; not published.
- **Purpose:** Event safety end to end: `holqa inspect --cycles` through the built `holqa` binary (an indirect cycle warning, an allowed cycle, prefix-safe object writes), and the same application on `createTestApp`, where the depth limit stops the unbounded cycle with a terminal dead letter and an idempotent consumer charges once. See its [README](../../examples/event-safety/README.md).

## `@holqa/example-observability`

- **Path:** `examples/observability`
- **Status:** Implemented. Private; not published.
- **Purpose:** The observability acceptance test: an HTTP request, the message it publishes, its processing with a secret token and the object it writes form one trace; logs identify every execution without the secret; retries and dead letters show in spans and metrics; telemetry reaches a stand-in OTLP/HTTP receiver and the application keeps working when the receiver is down; the built CLI records telemetry and prints it with `holqa traces`, `holqa logs` and `holqa metrics`. See its [README](../../examples/observability/README.md).

## `@holqa/example-package-smoke`

- **Path:** `examples/package-smoke`
- **Status:** Implemented. Private; not published.
- **Purpose:** Consumes `@holqa/core`, `@holqa/compiler`, `@holqa/cli`, `@holqa/local`, `@holqa/runtime-bun`, `@holqa/sdk`, `@holqa/testing`, and `@holqa/zod` through their public exports after they are built. It verifies that `dist/` contains JavaScript and declarations, that no unresolved `@/` aliases remain in emitted `.js` or `.d.ts` files, that the built `holqa` binary runs, that the built compiler compiles an SDK application, and that the manifest JSON Schemas and the CLI's analysis entry point are shipped.
- **Run:** `pnpm --filter @holqa/example-package-smoke test` (after `pnpm build`), or as part of `pnpm test` / `pnpm check`.

## Planned packages

| Package | Intended responsibility | Allowed internal dependencies |
| --- | --- | --- |
| `@holqa/runtime-bun` (extensions) | Worker or process isolation. | `core` |
| `@holqa/testing` (extensions) | Fixtures and replay adapters for external services. | `core`, `sdk`, `local`, `runtime-bun` |
| `@holqa/client` | Fetch-based runtime for generated, browser-safe clients. Runtime-neutral. | `core` |
| `packages/integrations/*` (except `zod` and `opentelemetry`) | Schema, handler, transport, and client adapters. See [integrations](../integrations/index.md). | `core`, `sdk`, `client` |

See the [roadmap](../roadmap.md) for when each is expected.

## Related

- [Package boundaries](../architecture/package-boundaries.md)
- [Architecture overview](../architecture/overview.md)
- [Releasing](../contributing/releasing.md)
