# Diagnostic codes

> **Status:** Ninety-five codes are **Implemented** and registered in `diagnosticCodes` (`@holqa/core`). No planned code is listed at the moment.

Every problem Holqa reports is a structured `Diagnostic` with a stable code. Tools, CI scripts, and agents should match on the code, never on the message text, which may be reworded.

## Diagnostic shape

```ts
interface Diagnostic {
  readonly code: DiagnosticCode;
  readonly severity: "error" | "warning" | "info";
  readonly message: string;
  readonly location?: { readonly file: string; readonly line?: number; readonly column?: number };
  readonly hint?: string;
  readonly details?: JsonObject;
}
```

| Field | Meaning |
| --- | --- |
| `code` | A registered `HOLQA_*` code. |
| `severity` | `error` diagnostics fail the operation that produced them; `warning` and `info` do not. |
| `message` | A human-readable description. Not stable. |
| `location` | Optional source position; `line` and `column` are 1-based. |
| `hint` | Optional actionable guidance. |
| `details` | Optional structured data, such as the failing field paths of `HOLQA_INPUT_INVALID` or the JSON path of `HOLQA_PAYLOAD_NOT_SERIALIZABLE`. Never contains rejected values or secrets. Its keys are documented per code below and are part of the contract. |

Human-readable form (from `formatDiagnostic`; the location is shown for illustration, since `parseResourceId` itself does not attach one):

```text
infra.ts:12:7 error HOLQA_RESOURCE_ID_INVALID: Resource identifier "Orders" is invalid.
  hint: Use lowercase letters and digits, start with a letter, and separate segments with a single "-" or ".".
```

JSON form (as emitted by `holqa --json`):

```json
{"diagnostics":[{"code":"HOLQA_CLI_UNKNOWN_COMMAND","severity":"error","message":"Unknown command \"foo\".","hint":"Run \"holqa --help\" to list commands."}]}
```

## Implemented codes

| Code | Registry key | Emitted by | Meaning |
| --- | --- | --- | --- |
| `HOLQA_RESOURCE_ID_INVALID` | `resourceIdInvalid` | `parseResourceId` (`@holqa/core`) | A value is not a valid resource identifier: not a string, empty, longer than 63 characters, or not matching `^[a-z][a-z0-9]*(?:[-.][a-z0-9]+)*$`. |
| `HOLQA_CLI_UNKNOWN_COMMAND` | `cliUnknownCommand` | `runCli` (`@holqa/cli`) | The CLI received a command it does not recognize. Exit code `2`. |
| `HOLQA_CLI_NOT_IMPLEMENTED` | `cliNotImplemented` | `runCli` (`@holqa/cli`) | The command is a proposed command that has not been implemented yet: today `holqa openapi generate`, and `holqa build` without `--manifest`. Exit code `1`. |
| `HOLQA_MANIFEST_NOT_SERIALIZABLE` | `manifestNotSerializable` | `canonicalJsonStringify` via `CanonicalJsonError` (`@holqa/compiler`) | A value cannot be represented in canonical JSON (for example `undefined`, a function, a `Date`, `NaN`, or a cycle). The message includes the JSON path. |
| `HOLQA_RESOURCE_ID_DUPLICATE` | `resourceIdDuplicate` | `checkIdentities` (`@holqa/core`), `defineApp` (`@holqa/sdk`) | Two resources in one application share an identifier. The message names every alias involved. |
| `HOLQA_DECLARATION_INVALID` | `declarationInvalid` | `@holqa/sdk` factories, registrations, `defineApp`, `composeResources`; `compileApplication` (`@holqa/compiler`) | A declaration is malformed: a missing or invalid option (including a handler's `events` or `idempotency` policy, for example an empty cycle justification), a value that is not a Standard Schema, a non-resource in `resources`, a resource that already belongs to another application, an alias declared by two groups, or an operation on a handle never passed to `defineApp`. |
| `HOLQA_INPUT_INVALID` | `inputInvalid` | `validateInput` via `InputValidationError` (`@holqa/core`); queue `send` and handler `invoke` (`@holqa/sdk`) | Untrusted input failed schema validation at a trust boundary. The message lists issue paths and messages but never the rejected value. Queue delivery (`@holqa/runtime-bun`) dead-letters messages that fail their schema without a retry and records this code. |
| `HOLQA_RUNTIME_NOT_BOUND` | `runtimeNotBound` | `requireBinding`, `resolveDriver`, `readConfig` (`@holqa/core`); handles and `app.env` (`@holqa/sdk`) | A resource handle or configuration value was used while no runtime binding is installed, for example at module top level. |
| `HOLQA_RUNTIME_ALREADY_BOUND` | `runtimeAlreadyBound` | `bindApp` (`@holqa/core`) | A binding was installed on an application instance that already has one. |
| `HOLQA_BINDING_CAPABILITY_UNSUPPORTED` | `bindingCapabilityUnsupported` | `bindApp`, `checkCapabilities`, `resolveDriver` (`@holqa/core`); `Runtime.start` (`@holqa/runtime-bun`); queue `send`, bucket `signedUrl` and idempotent handlers (`@holqa/sdk`) | A binding does not support a declared resource kind, cannot satisfy a declared requirement (including a queue's `backoff`), has no driver for a kind with operations, cannot deliver a handler's trigger (no source, or an object event type it does not advertise; `details`: `handler`, `trigger`), or cannot honour an operation (a send delay beyond `maxDelaySeconds`, a message larger than `maxMessageBytes`, signed URLs it does not issue or not for that long), or lacks a store the runtime or a handler needs (an idempotency store for handlers that declare `idempotency`, an operation budget store for `events.maxEventsPerOperation`). One diagnostic per shortfall. Requirement shortfalls carry `details`: `resource`, `kind`, `binding` (the provider selected for the resource) and `requirement` (the unmet capability, for example `queue.dead-letter`); undeliverable triggers also carry `binding` and `requirement` (`trigger.<kind>`). |
| `HOLQA_SCHEMA_UNSUPPORTED` | `schemaUnsupported` | `normalizeSchema`, `describeSchemaContract` (`@holqa/compiler`) | A schema, or its wire side, has no faithful portable description: not a Standard Schema, no adapter and no Standard JSON Schema, a non-JSON type such as `Date`, or an adapter failure. `details`: `subject`, `path`. |
| `HOLQA_SCHEMA_FIDELITY_UNVERIFIED` | `schemaFidelityUnverified` | `normalizeSchema` (`@holqa/compiler`) | Warning. The schema was described by its own Standard JSON Schema converter because no Holqa adapter matches its vendor. `details`: `subject`, `vendor`. |
| `HOLQA_SCHEMA_RUNTIME_ONLY` | `schemaRuntimeOnly` | `normalizeSchema` (`@holqa/compiler`) | Warning. A constraint (refinement, rewrite, coercion, ...) is validated at runtime but missing from the portable description. One per constraint. `details`: `subject`, `path`, `kind`. |
| `HOLQA_SCHEMA_CHANGE_BREAKING` | `schemaChangeBreaking` | `checkSchemaCompatibility` (`@holqa/compiler`) | A contract change rejects data the previous contract accepted, for the contract's role, and `schemaVersion` was not increased. `details`: `subject`, `path`, `kind`, `direction`, `classification`, `previousVersion`, `nextVersion`. |
| `HOLQA_SCHEMA_CHANGE_POTENTIALLY_BREAKING` | `schemaChangePotentiallyBreaking` | `checkSchemaCompatibility` (`@holqa/compiler`) | Warning. A change may reject some data, for example during a rolling deployment or with a changed pattern. Same `details`. |
| `HOLQA_SCHEMA_CHANGE_UNVERIFIABLE` | `schemaChangeUnverifiable` | `checkSchemaCompatibility` (`@holqa/compiler`) | Warning. A change uses constructs the checker does not analyze, or a contract is unverified (for every role). Same `details`. |
| `HOLQA_SCHEMA_MIGRATION_REQUIRED` | `schemaMigrationRequired` | `checkSchemaCompatibility` (`@holqa/compiler`) | Warning. A breaking change came with a higher `schemaVersion`; data written with the old version must be drained or migrated. Same `details`. |
| `HOLQA_SCHEMA_VERSION_INVALID` | `schemaVersionInvalid` | `describeSchemaContract`, `checkSchemaCompatibility` (`@holqa/compiler`); `createMessageCodec` (`@holqa/core`) | A schema version is not a positive integer, or is lower than the previous version. |
| `HOLQA_PAYLOAD_NOT_SERIALIZABLE` | `payloadNotSerializable` | `toWirePayload`, `encodeJsonPayload`, `prepareWirePayload`, message codecs via `PayloadError` (`@holqa/core`); queue `send` (`@holqa/sdk`) | A value has no JSON wire form (`Date`, `bigint`, `NaN`, `Map`, a cycle, ...). `details`: `subject`, `path` (for example `$.lines[0].placedAt`). |
| `HOLQA_PAYLOAD_MALFORMED` | `payloadMalformed` | `decodeJsonPayload`, `decodeMessageEnvelope`, message codecs, `readObjectEvent` (`@holqa/core`); delivery workers (`@holqa/runtime-bun`) | Received bytes are not valid UTF-8 JSON, not a well-formed `holqa.message/1` envelope, or not a well-formed `holqa.object-event/1` event. `details`: `subject`, `path`. Delivery workers dead-letter such deliveries without a retry. |
| `HOLQA_PAYLOAD_VERSION_UNSUPPORTED` | `payloadVersionUnsupported` | Message codecs (`@holqa/core`); queue delivery (`@holqa/runtime-bun`) | A received message was produced with a schema version the consumer does not accept. `details` (codecs): `subject`, `path`. Queue delivery dead-letters such messages without a retry and records this code. |
| `HOLQA_APP_NOT_FOUND` | `appNotFound` | `holqa inspect`, `holqa build`, `holqa dev`, the operation commands, `holqa doctor` (`@holqa/cli`) | The application module (`infra.ts` or `--app`) does not exist. |
| `HOLQA_APP_INVALID` | `appInvalid` | `compileApplication` (`@holqa/compiler`) | The application module's default export is not a Holqa application, or carries a descriptor of another protocol version. |
| `HOLQA_MODULE_EVALUATION_FAILED` | `moduleEvaluationFailed` | `moduleEvaluationFailure` (`@holqa/compiler`), via the CLI's analysis | Importing the application module or a handler module threw. `details`: `module`, and `cause` when the error was a Holqa error (for example `HOLQA_RUNTIME_NOT_BOUND` for configuration read at module top level). |
| `HOLQA_HANDLER_PATTERN_UNMATCHED` | `handlerPatternUnmatched` | `selectHandlerModules` (`@holqa/compiler`) | Warning. A `handlers` include pattern matched no module. `details`: `pattern`. |
| `HOLQA_HANDLER_ID_DUPLICATE` | `handlerIdDuplicate` | `compileApplication` (`@holqa/compiler`) | Two different handler registrations share an identifier. One diagnostic per extra registration. `details`: `id`, `modules`. |
| `HOLQA_RESOURCE_NOT_FOUND` | `resourceNotFound` | `compileApplication` (`@holqa/compiler`); `holqa queue send`, `queue redrive`, `storage put`, `cron run` (`@holqa/cli`); `createTestApp` helpers (`@holqa/testing`) | A handler's trigger, or its `events.publishes`, references a resource the application does not declare, or a command or test helper names a queue, bucket or schedule that does not exist. The hint lists the declared resources of that kind. `details` (compiler only): `handler`, `resource`, `kind`. |
| `HOLQA_TRIGGER_INVALID` | `triggerInvalid` | `compileApplication` (`@holqa/compiler`) | A trigger targets a resource of another kind, has malformed options or schema roles, or a queue consumer's message contract differs from its queue's. `details`: `handler`, `trigger`. |
| `HOLQA_QUEUE_CONSUMER_DUPLICATE` | `queueConsumerDuplicate` | `compileApplication` (`@holqa/compiler`), `createRuntime` (`@holqa/runtime-bun`) | A queue has more than one consumer. `details` (compiler only): `queue`, `handlers`. |
| `HOLQA_ROUTE_CONFLICT` | `routeConflict` | `compileApplication` (`@holqa/compiler`), `createRuntime` (`@holqa/runtime-bun`) | Two HTTP routes or RPC procedures of one application serve the same method and path shape (parameter names ignored), whichever APIs they belong to. The compiler and runtime apply the same rule (`httpRouteKeys`). A procedure serves `POST <basePath>/rpc/<id>`, and queries also `GET`. `details`: `route`, `handlers`. Also: two static sites served under the same base path (`createRuntime`). |
| `HOLQA_MANIFEST_INVALID` | `manifestInvalid` | `validateManifest`, `validateEntrypoints` (`@holqa/compiler`) | A manifest or entry point map does not match its JSON Schema or its cross-references. One per problem. `details`: `path`. |
| `HOLQA_MANIFEST_VERSION_UNSUPPORTED` | `manifestVersionUnsupported` | `validateManifest` (`@holqa/compiler`) | The document's `manifestVersion` is not one the reader understands. `details`: `found`, `supported`. |
| `HOLQA_ANALYSIS_FAILED` | `analysisFailed` | `holqa inspect`, `holqa build` (`@holqa/cli`); `validateEventAnalysis` (`@holqa/compiler`) | The analysis process exited without a report, exceeded its timeout, or sent a malformed report (including a malformed event analysis); or `holqa inspect --cycles` ran on a host that provides no event analysis. `details`: `output` (the last 4000 characters the process printed), and `exitCode` or `timeoutMs`. |
| `HOLQA_CLI_ARGUMENT_INVALID` | `cliArgumentInvalid` | `runCli` (`@holqa/cli`) | An unknown, repeated or value-less option, a missing or unexpected positional argument, or a malformed value (JSON for `--input`/`--data`, a number for `--port`, `--attempt`, `--delay`, `--limit`) for any implemented command. Exit code `2`. |
| `HOLQA_BUILD_OUTPUT_FAILED` | `buildOutputFailed` | `holqa build`, `holqa dev`, the operation commands (`@holqa/cli`) | The build output (for `holqa dev` and the operation commands, `.holqa/dev/build`) could not be written. |
| `HOLQA_HTTP_ROUTE_NOT_FOUND` | `httpRouteNotFound` | `@holqa/runtime-bun` | No route or procedure serves the request path. HTTP `404`. |
| `HOLQA_HTTP_METHOD_NOT_ALLOWED` | `httpMethodNotAllowed` | `@holqa/runtime-bun`; local signed URL serving (`@holqa/local`) | A route or procedure serves the path, but not the method; or a signed URL was requested with a method other than `GET`, `HEAD` or `PUT`. HTTP `405` with an `allow` header. |
| `HOLQA_HTTP_MEDIA_TYPE_UNSUPPORTED` | `httpMediaTypeUnsupported` | Route and procedure `invoke` (`@holqa/sdk`) | A non-empty request body is not declared as JSON (`application/json` or `application/*+json`). HTTP `415`. |
| `HOLQA_HTTP_REJECTED` | `httpRejected` | `HttpRejectedError` (`@holqa/core`) | Middleware or a handler rejected the request with an explicit status and a caller-safe message. `details`: `status`. |
| `HOLQA_RESPONSE_INVALID` | `responseInvalid` | Route and procedure `invoke` (`@holqa/sdk`), `@holqa/runtime-bun` | A handler or middleware produced a response its contract does not declare: an undeclared status, a body its schema rejects, a body on `204`, or a value that is not a response. HTTP `500` with a generic message; `details` (logged only): `status`, `causes`. |
| `HOLQA_HANDLER_FAILED` | `handlerFailed` | `@holqa/runtime-bun` | A handler threw an error that is not an `HttpRejectedError`. HTTP `500`; the message is generic and the original error is logged with the invocation identifier. |
| `HOLQA_HANDLER_NOT_FOUND` | `handlerNotFound` | `Runtime.invoke` (`@holqa/runtime-bun`), `holqa invoke` (`@holqa/cli`) | An invocation names a handler the runtime has not registered. `holqa invoke` lists the registered handlers in the hint. |
| `HOLQA_INVOCATION_TIMEOUT` | `invocationTimeout` | `@holqa/runtime-bun`; `settle` (`@holqa/local`) | An invocation exceeded its time limit (including time waiting for a slot); its signal was aborted. HTTP `504`. A local environment's `settle` also reports it when work is still pending after its time limit (`details`: `channels`). |
| `HOLQA_INVOCATION_CANCELLED` | `invocationCancelled` | `@holqa/runtime-bun` | The caller aborted the invocation (for example an HTTP client disconnected), or the runtime stopped after its grace period. HTTP `503`. |
| `HOLQA_RUNTIME_OVERLOADED` | `runtimeOverloaded` | `@holqa/runtime-bun` | Every concurrency slot is held and the wait queue is full. HTTP `503` with `retry-after: 1`. |
| `HOLQA_RUNTIME_NOT_RUNNING` | `runtimeNotRunning` | `@holqa/runtime-bun`; local scheduler `trigger` (`@holqa/local`) | The runtime has not started, or is stopping or stopped. HTTP `503`. Also thrown by `scope.use` while stopping, and by a local manual schedule run when no runtime receives the schedule. |
| `HOLQA_RUNTIME_START_FAILED` | `runtimeStartFailed` | `createRuntime`, `Runtime.start` (`@holqa/runtime-bun`) | The runtime cannot start: invalid options (limits, delivery, CORS), or a failed start, followed by its causes (for example `HOLQA_CONFIG_INVALID`, `HOLQA_RUNTIME_ALREADY_BOUND`, `HOLQA_BINDING_CAPABILITY_UNSUPPORTED` for a trigger the binding cannot deliver, `HOLQA_SCHEDULE_INVALID`). Earlier versions of `createRuntime` reported undeliverable handlers with this code while creating the runtime; `start` reports them now. |
| `HOLQA_CONFIG_INVALID` | `configInvalid` | `createEnvironmentBinding` (`@holqa/runtime-bun`) | A configuration value is missing or fails its schema. Secrets are reported by name only; neither the value nor the schema's message appears. `details`: `name`, `kind`, `missing`. |
| `HOLQA_RPC_VERSION_UNSUPPORTED` | `rpcVersionUnsupported` | Procedure `invoke` (`@holqa/sdk`) | The `holqa-rpc-version` request header names a protocol version other than `1`. HTTP `400`. |
| `HOLQA_OPERATION_INVALID` | `operationInvalid` | Queue `send`, bucket `put`, `list` and `signedUrl` (`@holqa/sdk`); local drivers (`@holqa/local`) | A resource operation received malformed options: a negative or fractional `delaySeconds`, a body that is neither a string nor a `Uint8Array`, an empty content type, a `limit` outside 1 to 1 000, a cursor the driver did not issue, a signed URL method other than `GET`/`PUT`. Local signed uploads larger than the limit answer HTTP `413` with this code. `manualTriggerMetadata` (`@holqa/local`) and `holqa invoke` report it for HTTP handlers, which are called over HTTP, and for an attempt that is not a positive integer; `holqa storage put` for files over 64 MiB; `TestApp.replay` (`@holqa/testing`) for a malformed recording or an invocation without a JSON input. |
| `HOLQA_OBJECT_KEY_INVALID` | `objectKeyInvalid` | `checkObjectKey` (`@holqa/core`), every bucket operation (`@holqa/sdk`), local signed URL serving (`@holqa/local`, HTTP `400` for a malformed percent-encoding) | An object key is empty, longer than 1 024 UTF-8 bytes, contains a control character, starts with `/`, or has a `.` or `..` segment. |
| `HOLQA_OBJECT_NOT_FOUND` | `objectNotFound` | Local signed URL serving (`@holqa/local`) | A signed or public URL names an object, bucket or path that does not exist. HTTP `404`. Handle operations report missing objects as `undefined` or `false` instead. |
| `HOLQA_SIGNED_URL_INVALID` | `signedUrlInvalid` | Local signed URL serving (`@holqa/local`) | A signed URL is expired, was signed for another method or object, has a signature that does not match, or an upload does not send the signed content type. HTTP `403`. |
| `HOLQA_SCHEDULE_INVALID` | `scheduleInvalid` | `parseCronSchedule` (`@holqa/core`), schedule sources (`@holqa/local`) | A cron expression cannot be evaluated (wrong field count, out-of-range values, unsupported extensions such as `L`, `W`, `#`), its time zone is unknown to the runtime, or the schedule never fires. The SDK reports the same problems in declarations as `HOLQA_DECLARATION_INVALID`. |
| `HOLQA_LOCAL_STATE_UNSUPPORTED` | `localStateUnsupported` | `createLocalEnvironment` (`@holqa/local`) | The state directory was written by a newer, incompatible version of the local drivers. |
| `HOLQA_DELIVERY_ATTEMPTS_EXHAUSTED` | `deliveryAttemptsExhausted` | Delivery workers (`@holqa/runtime-bun`) | A queue message or object event was received more often than its attempts allow without being settled, for example because its leases kept expiring. Recorded as the failure of the dead-lettered or discarded delivery. |
| `HOLQA_SCHEDULE_RUN_SKIPPED` | `scheduleRunSkipped` | Schedule transport (`@holqa/runtime-bun`) | A scheduled run was not started because the previous run was still in progress and the overlap policy is `skip`. Reported as the code of a `skipped` run. |
| `HOLQA_RELOAD_FAILED` | `reloadFailed` | `holqa dev` (`@holqa/cli`) | A development rebuild failed: the application no longer analyzes, or the next generation could not be prepared or started. Followed by its causes (for example `HOLQA_MODULE_EVALUATION_FAILED`, `HOLQA_TRIGGER_INVALID`, `HOLQA_CONFIG_INVALID`). The message says whether the previous generation keeps serving; failures before the swap always leave it serving. Also reported when changed handlers cannot be loaded for an in-place replacement (the running implementations keep serving, and the session is reported stale), and, with severity `info`, when a replacement is refused in favour of a restart (for example because new code created timers or listeners while loading). |
| `HOLQA_DEV_SESSION_ACTIVE` | `devSessionActive` | `holqa dev`, operation commands (`@holqa/cli`) | Another `holqa dev` already runs the application or uses its state directory: `.holqa/dev/session.json` or the state directory's `dev-session.json` names a running process. Operation commands report it when the running session uses another state directory than the one given. Exit code `1`. |
| `HOLQA_DEV_START_FAILED` | `devStartFailed` | `holqa dev` (`@holqa/cli`) | The dev server could not listen, for example because the port is in use. Exit code `1`. |
| `HOLQA_FILE_UNREADABLE` | `fileUnreadable` | `holqa storage put` (`@holqa/cli`) | A file named on the command line does not exist or cannot be read. Exit code `1`. |
| `HOLQA_DOCTOR_CHECK_FAILED` | `doctorCheckFailed` | `holqa doctor` (`@holqa/cli`) | A doctor check found an error; one per failed check, followed by the check's own diagnostics. Exit code `1`. |
| `HOLQA_LOCAL_OPERATION_FAILED` | `localOperationFailed` | Operation commands and `holqa dev` (`@holqa/cli`) | A local operation (invoke, queue send, queue redrive, storage put, cron run, state) failed unexpectedly, for example because the process running the application exited, did not answer in time, or threw an error that carries no diagnostic. Also used when a generation exits while serving. |
| `HOLQA_EVENT_CYCLE` | `eventCycle` | `compileApplication`, `analyzeEvents`, `eventCycleDiagnostics` (`@holqa/compiler`); `holqa inspect`, `holqa build --manifest` (`@holqa/cli`) | Handlers may publish events that trigger themselves, directly or through other handlers, and none of them declares the cycle as intentional. A **warning** when every publication on the reported path is known, **information** when some are potential. Never fails compilation. `details`: `certainty`, `handlers`, `path` (`handler`, `resource`, `operation`, `certainty`, `call?`, `location?` per step). |
| `HOLQA_EVENT_DEPTH_EXCEEDED` | `eventDepthExceeded` | Traced drivers and delivery workers (`@holqa/runtime-bun`) | An event was refused because it would be (when published) or is (when delivered) deeper in its causal chain than the receiving handler's `maxDepth`. Terminal: the delivery is dead-lettered or discarded without a retry. `details` (on publication): `handler`, `depth`, `limit`, `receiver`. |
| `HOLQA_EVENT_PUBLICATION_LIMIT_EXCEEDED` | `eventPublicationLimitExceeded` | Traced drivers (`@holqa/runtime-bun`) | An invocation tried to publish more events than its `maxPublications`. Terminal for the delivery that ran it. `details`: `handler`, `limit`. |
| `HOLQA_EVENT_AGE_EXCEEDED` | `eventAgeExceeded` | Delivery workers (`@holqa/runtime-bun`) | A delivery was sent longer ago than `events.maxEventAgeMs` and was not delivered. Terminal. |
| `HOLQA_EXECUTION_BUDGET_EXCEEDED` | `executionBudgetExceeded` | Traced drivers (`@holqa/runtime-bun`) | The root operation already published `events.maxEventsPerOperation` events, counted by the binding's operation budget store. Terminal for the delivery that ran into it. `details`: `handler`, `limit`, `used`, `rootId`. |
| `HOLQA_IDEMPOTENCY_IN_PROGRESS` | `idempotencyInProgress` | Idempotent handlers (`@holqa/sdk`) | Another delivery holds the handler's idempotency key; this delivery fails and is retried with the queue's backoff. |
| `HOLQA_SIMULATION_BUDGET_EXCEEDED` | `simulationBudgetExceeded` | `createTestApp` (`@holqa/testing`) | A test application ran more than its `maxInvocations`, usually because of an event cycle or unbounded fan-out. Thrown by `flush`, `advance` and `drain`. `details`: `maxInvocations`, `started`, `busiest`, `chain`. |
| `HOLQA_TELEMETRY_CONFIG_INVALID` | `telemetryConfigInvalid` | `createRuntime` (`@holqa/runtime-bun`), `createOtlpHttpExporter` and `readOtelEnvironment` (`@holqa/opentelemetry`), application processes of `@holqa/cli` | Telemetry settings are invalid or ask for something unsupported: an out-of-range `sampleRatio`, an unknown limit, an endpoint that is not an absolute http or https URL, an OTLP protocol other than `http/json`, an unsupported sampler or exporter. Header values never appear in the message. |
| `HOLQA_TELEMETRY_EXPORT_FAILED` | `telemetryExportFailed` | Telemetry export pipeline (`@holqa/runtime-bun`) | A `warn` log entry, not a thrown error: an exporter rejected or timed out on a batch, which was dropped for that exporter. Written at most once per minute per exporter and signal; fields `exporter`, `signal`, `failures`, `error`. Invocations are unaffected. |
| `HOLQA_TELEMETRY_NOT_FOUND` | `telemetryNotFound` | `holqa traces inspect`, `holqa events inspect` (`@holqa/cli`) | No trace, message or object event with the given identifier is recorded in the local telemetry store or state. Exit code `1`. |
| `HOLQA_HANDLER_REPLACEMENT_INVALID` | `handlerReplacementInvalid` | `Runtime.replaceHandlers` (`@holqa/runtime-bun`), `holqa dev` (`@holqa/cli`) | A replacement named an unknown handler, named one twice, or changed a handler's definition (trigger, event policy, idempotency) or schema roles. One diagnostic per problem; nothing is replaced. `details`: `handler`. `holqa dev` restarts the generation instead. |
| `HOLQA_QUEUED_MESSAGE_INCOMPATIBLE` | `queuedMessageIncompatible` | Generation processes of `holqa dev` (`@holqa/cli`) | A `warn` log entry, not a thrown error: after a queue's contract changed, messages already waiting in the local queue do not validate against the new message schema, or were written with another `schemaVersion`. Fields `resourceId`, `waiting`, `incompatible`, `otherSchemaVersion`, `messageIds` (at most ten), `problem`. Messages are kept. |
| `HOLQA_BINDING_CONFIG_INVALID` | `bindingConfigInvalid` | `validateProvider`, `bindingFailure`, `credentialRef` (`@holqa/core`); providers | A binding provider's declaration or settings are malformed or contradictory. Permanent. `details`: `binding`, `failure` (`configuration`), `transient` (`false`). |
| `HOLQA_BINDING_CREDENTIALS_MISSING` | `bindingCredentialsMissing` | `bindingFailure` (`@holqa/core`); providers | A credential a binding needs is not set. The value is never included. `details`: `binding`, `failure`, `transient`. |
| `HOLQA_BINDING_CREDENTIALS_INVALID` | `bindingCredentialsInvalid` | `bindingFailure` (`@holqa/core`); providers | Infrastructure rejected a binding's credentials (authentication or authorization). The value is never included. `details`: `binding`, `failure`, `transient`. |
| `HOLQA_BINDING_CONTRACT_INCOMPATIBLE` | `bindingContractIncompatible` | `validateProvider`, `bindingFailure` (`@holqa/core`) | A provider implements a provider protocol version, contract version, contract, resource kind or service this version of Holqa does not. `details`: `binding`, `failure` (`version`), `transient`. |
| `HOLQA_BINDING_UNAVAILABLE` | `bindingUnavailable` | `bindingFailure` (`@holqa/core`); providers | Infrastructure a binding needs is temporarily unreachable. The only transient binding failure (`isTransientBindingFailure`). `details`: `binding`, `failure`, `transient` (`true`). |
| `HOLQA_BINDING_FAILED` | `bindingFailed` | `bindingFailure` (`@holqa/core`); providers | A binding failed permanently, for example because the queue or bucket it connects to does not exist. `details`: `binding`, `failure`, `transient`. |
| `HOLQA_BINDING_RESOURCE_UNKNOWN` | `bindingResourceUnknown` | `resolveBindings` (`@holqa/bindings`) | A binding configuration selects a provider for a resource identifier, or a resource kind, the application does not declare. `details`: `resource` or `kind`. |
| `HOLQA_BINDING_KIND_MISMATCH` | `bindingKindMismatch` | `resolveBindings` (`@holqa/bindings`) | A selected provider does not bind the resource's kind, or a service provider does not supply the service. Resolution never falls through to another provider. `details`: `resource`, `kind` or `service`, `binding`, `selection`. |
| `HOLQA_BINDING_MISSING` | `bindingMissing` | `resolveBindings`, composed bindings (`@holqa/bindings`) | No provider is selected for a declared resource. `details`: `resource`, `kind`. |
| `HOLQA_BINDING_TOPOLOGY_UNSUPPORTED` | `bindingTopologyUnsupported` | `validateBindings` (`@holqa/bindings`); `holqa bindings validate` (`@holqa/cli`) | The deployment cannot deliver what the application needs: a background handler whose resource's provider delivers no events, or pull-based delivery on a request-driven execution host. `details`: `handler`, `resource`, `binding`, `host`. |
| `HOLQA_EXTENSION_INVALID` | `extensionInvalid` | `defineExtension` (`@holqa/core`) | An extension definition is malformed: identifier, version, runtimes, dependencies or configuration schema. `defineApp` reports malformed extension declarations as `HOLQA_DECLARATION_INVALID`. |
| `HOLQA_EXTENSION_MISSING` | `extensionMissing` | `checkExtensions`, `requireExtension` (`@holqa/core`); `validateBindings` (`@holqa/bindings`); `Runtime.start` (`@holqa/runtime-bun`) | A required extension, or an extension another one depends on, has no implementation in the binding. `details`: `extension`, `version`, `binding`, and `dependent` for dependencies. |
| `HOLQA_EXTENSION_INCOMPATIBLE` | `extensionIncompatible` | Same as above | An extension is implemented in another version than the one used (a warning for optional extensions, which are then treated as absent), or for runtimes the execution host does not run. `details`: `extension`, `version`, `provided`, `binding`. |
| `HOLQA_BUILD_STALE` | `buildStale` | `loadCompiledApplication` (`@holqa/runtime-bun`) | Build output no longer matches the application: the entry point map belongs to another manifest, or the application name, resources (kind, identifier, settings, requirements), configuration entries, handler exports or triggers differ from the manifest. Schema changes and handler modules added after the build are not detected. Rebuild with `holqa build --manifest`. |
| `HOLQA_PACKAGE_FAILED` | `packageFailed` | `holqa package` (`@holqa/cli`) | No deployment artifact could be written: a static site's directory is missing, bundling failed, writing failed, or the output directory is not empty and holds no previous artifact. |
| `HOLQA_ARTIFACT_INVALID` | `artifactInvalid` | `verifyArtifact`, `startContainer` (`@holqa/container`) | A deployment artifact is incomplete, altered or does not match what runs: a listed file is missing or its hash differs (`details.file`), a manifest is missing or malformed, the Bun version is older than `runtime.bun`, it was packaged for another application, or the binding resolved at start differs from `bindings.json` (`details.fields`). |
| `HOLQA_CONTAINER_SETTINGS_INVALID` | `containerSettingsInvalid` | `readContainerSettings`, `startContainer` (`@holqa/container`) | A container setting from the environment is invalid: `PORT`, `HOST`, `HOLQA_SHUTDOWN_GRACE_MS`, `HOLQA_SHUTDOWN_FORCE_MS` or `HOLQA_MAX_REQUEST_BODY_BYTES` (`details.variable`). |
| `HOLQA_PROVISIONING_CONFIG_INVALID` | `provisioningConfigInvalid` | `defineProvisioning`, `planProvisioning` (`@holqa/bindings`); `s3.provisioner` (a warning); `holqa provision` | A provisioning configuration or provisioner is malformed, implements another protocol version, or two provisioners manage one target. As a warning: a bucket has object event handlers but the S3 provisioner has no notification target. |
| `HOLQA_PROVISIONING_FAILED` | `provisioningFailed` | `planProvisioning`, `applyProvisioning` (`@holqa/bindings`); `holqa provision` | A provisioner failed to inspect or change infrastructure. Changes applied before the failure stay applied and are listed in the result. |
| `HOLQA_PROVISIONING_DESTRUCTIVE` | `provisioningDestructive` | `applyProvisioning` (`@holqa/bindings`); `holqa provision apply` | The plan has a `replace` or `delete` change that was not authorized; nothing was applied. `details`: `provisioner`, `type`, `target`, `action`. |

`@holqa/runtime-bun` also reports `HOLQA_INPUT_INVALID` (`400`) for a direct invocation with an invalid `timeoutMs` or with metadata that does not fit the handler's trigger kind, and for a request path with invalid percent-encoding.

Over HTTP, `HOLQA_INPUT_INVALID` (`400`), `HOLQA_PAYLOAD_MALFORMED` (`400`) and `HOLQA_HTTP_MEDIA_TYPE_UNSUPPORTED` (`415`) are caller errors only when they come from reading the request; the same codes raised later by handler code (for example an invalid queue `send`) are server errors and answer `HOLQA_HANDLER_FAILED`. Event limit refusals raised in handler code (`HOLQA_EVENT_DEPTH_EXCEEDED`, `HOLQA_EVENT_PUBLICATION_LIMIT_EXCEEDED`, `HOLQA_EXECUTION_BUDGET_EXCEEDED`) keep their code, with status `500` and a generic message. See the [runtime reference](runtime.md#error-responses).

`HOLQA_INPUT_INVALID` carries `details: { subject, issues }`, where each issue has `path`, `pointer`, `segments`, `message` and optional scalar library `details` (for example Zod's `code` and `minimum`). See [schema contracts](schema-contracts.md).

Codes are `error` severity unless marked as a warning above. Errors thrown by `@holqa/core` and `@holqa/sdk` are `HolqaError` instances whose `diagnostics` list every problem found.

## Stability policy

- Codes are part of Holqa's public, machine-readable contract.
- Once released, a code is **never renamed** and **never reused** for a different meaning.
- A code that is no longer emitted remains reserved and documented as retired.
- Message text and hints may change at any time; codes may not.
- New codes are added to `diagnosticCodes` in `packages/core/src/diagnostics/codes.ts` and documented on this page in the same change.
- The "versioned" aspect of codes means the registry evolves only by addition; consumers built against an older registry continue to work.

## Naming convention

Codes follow `HOLQA_<AREA>_<PROBLEM>`:

- All uppercase, words separated by underscores.
- `<AREA>` names the subsystem or concept: `RESOURCE`, `SCHEMA`, `MANIFEST`, `CLI`, `HANDLER`, `ROUTE`, `BINDING`, `CONFIG`.
- `<PROBLEM>` describes the condition, not the remedy: `INVALID`, `NOT_FOUND`, `DUPLICATE`, `UNSUPPORTED`, `NOT_IMPLEMENTED`.
- The registry key in `diagnosticCodes` is the camelCase equivalent (`HOLQA_RESOURCE_ID_INVALID` → `resourceIdInvalid`).

## Planned codes (not implemented)

No planned code is listed at the moment. Previously planned codes were implemented: `HOLQA_ROUTE_AMBIGUOUS` as `HOLQA_ROUTE_CONFLICT` (which also covers RPC procedures), `HOLQA_CONFIG_INVALID`, and `HOLQA_RELOAD_FAILED`.

## Related

- [CLI reference](cli.md)
- [Compiler specification](compiler-specification.md)
- [Compiler](../architecture/compiler.md#diagnostics)
- [Agent-native development](../concepts/agent-native-development.md)
