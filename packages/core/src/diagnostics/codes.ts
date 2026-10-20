/**
 * Registry of every diagnostic code Holqa currently emits.
 *
 * Codes are part of Holqa's public, machine-readable contract: tools and
 * agents may match on them. Once released, a code must never be renamed or
 * reused for a different meaning. Add new codes instead.
 */
export const diagnosticCodes = {
  /** A resource identifier does not satisfy the identifier grammar. */
  resourceIdInvalid: "HOLQA_RESOURCE_ID_INVALID",
  /** The CLI received a command it does not recognize. */
  cliUnknownCommand: "HOLQA_CLI_UNKNOWN_COMMAND",
  /** The CLI received a proposed command that has not been implemented yet. */
  cliNotImplemented: "HOLQA_CLI_NOT_IMPLEMENTED",
  /** A value cannot be represented in Holqa's canonical JSON format. */
  manifestNotSerializable: "HOLQA_MANIFEST_NOT_SERIALIZABLE",
  /** Two resources in one application share a logical identifier. */
  resourceIdDuplicate: "HOLQA_RESOURCE_ID_DUPLICATE",
  /** A declaration is malformed: a missing or invalid option, a value that is not a schema, or a resource reused across applications. */
  declarationInvalid: "HOLQA_DECLARATION_INVALID",
  /** Untrusted input failed schema validation at a trust boundary. */
  inputInvalid: "HOLQA_INPUT_INVALID",
  /** A resource handle or configuration value was used while no runtime binding is installed. */
  runtimeNotBound: "HOLQA_RUNTIME_NOT_BOUND",
  /** A runtime binding was installed on an application that already has one. */
  runtimeAlreadyBound: "HOLQA_RUNTIME_ALREADY_BOUND",
  /** A runtime binding cannot satisfy a resource's declared requirements or has no driver for its kind. */
  bindingCapabilityUnsupported: "HOLQA_BINDING_CAPABILITY_UNSUPPORTED",
  /** A schema, or part of one, has no faithful portable representation and cannot be used as a wire contract. */
  schemaUnsupported: "HOLQA_SCHEMA_UNSUPPORTED",
  /** A schema was described through a generic converter whose output Holqa cannot verify. */
  schemaFidelityUnverified: "HOLQA_SCHEMA_FIDELITY_UNVERIFIED",
  /** A schema constraint is enforced at runtime but is missing from the portable description. */
  schemaRuntimeOnly: "HOLQA_SCHEMA_RUNTIME_ONLY",
  /** A schema contract change can reject data the previous contract accepted, and the schema version was not increased. */
  schemaChangeBreaking: "HOLQA_SCHEMA_CHANGE_BREAKING",
  /** A schema contract change may reject data in some deployments, for example during a rolling update. */
  schemaChangePotentiallyBreaking: "HOLQA_SCHEMA_CHANGE_POTENTIALLY_BREAKING",
  /** A schema contract change uses constructs the compatibility checker cannot analyze. */
  schemaChangeUnverifiable: "HOLQA_SCHEMA_CHANGE_UNVERIFIABLE",
  /** A breaking schema change came with a new schema version; data written with the old version needs a migration. */
  schemaMigrationRequired: "HOLQA_SCHEMA_MIGRATION_REQUIRED",
  /** A schema version is not a positive integer or is lower than the previous version. */
  schemaVersionInvalid: "HOLQA_SCHEMA_VERSION_INVALID",
  /** A value cannot be encoded as a wire payload, for example because it contains a `Date` or a `bigint`. */
  payloadNotSerializable: "HOLQA_PAYLOAD_NOT_SERIALIZABLE",
  /** Received wire bytes are not a well-formed payload or message envelope. */
  payloadMalformed: "HOLQA_PAYLOAD_MALFORMED",
  /** A received message was produced with a schema version the consumer does not accept. */
  payloadVersionUnsupported: "HOLQA_PAYLOAD_VERSION_UNSUPPORTED",
  /** The application module (conventionally `infra.ts`) does not exist. */
  appNotFound: "HOLQA_APP_NOT_FOUND",
  /** The application module's default export is not a Holqa application this version can read. */
  appInvalid: "HOLQA_APP_INVALID",
  /** Evaluating the application module or a handler module threw. */
  moduleEvaluationFailed: "HOLQA_MODULE_EVALUATION_FAILED",
  /** A handler discovery pattern matched no module. */
  handlerPatternUnmatched: "HOLQA_HANDLER_PATTERN_UNMATCHED",
  /** Two different handlers in one application share an identifier. */
  handlerIdDuplicate: "HOLQA_HANDLER_ID_DUPLICATE",
  /** A handler's trigger references a resource the application does not declare. */
  resourceNotFound: "HOLQA_RESOURCE_NOT_FOUND",
  /** A trigger registration is invalid: wrong resource kind, malformed options, or a contract that differs from the resource's. */
  triggerInvalid: "HOLQA_TRIGGER_INVALID",
  /** More than one consumer is registered for a queue. */
  queueConsumerDuplicate: "HOLQA_QUEUE_CONSUMER_DUPLICATE",
  /** Two HTTP routes match the same requests. */
  routeConflict: "HOLQA_ROUTE_CONFLICT",
  /** A manifest document does not match the manifest schema. */
  manifestInvalid: "HOLQA_MANIFEST_INVALID",
  /** A manifest document declares a manifest version this reader does not understand. */
  manifestVersionUnsupported: "HOLQA_MANIFEST_VERSION_UNSUPPORTED",
  /** The isolated analysis process failed, timed out or returned malformed output. */
  analysisFailed: "HOLQA_ANALYSIS_FAILED",
  /** The CLI received a malformed option or option value. */
  cliArgumentInvalid: "HOLQA_CLI_ARGUMENT_INVALID",
  /** The CLI could not write a build output file. */
  buildOutputFailed: "HOLQA_BUILD_OUTPUT_FAILED",
  /** No HTTP route or RPC procedure matches the request path. */
  httpRouteNotFound: "HOLQA_HTTP_ROUTE_NOT_FOUND",
  /** A route matches the request path, but not its method. */
  httpMethodNotAllowed: "HOLQA_HTTP_METHOD_NOT_ALLOWED",
  /** A request body has a media type the route or procedure does not accept. */
  httpMediaTypeUnsupported: "HOLQA_HTTP_MEDIA_TYPE_UNSUPPORTED",
  /** Middleware or a handler rejected a request with an explicit HTTP status. */
  httpRejected: "HOLQA_HTTP_REJECTED",
  /** A handler produced a response its contract does not declare: an undeclared status, or a body its schema rejects. */
  responseInvalid: "HOLQA_RESPONSE_INVALID",
  /** A handler threw an error that is not a Holqa diagnostic. Details are logged, never sent to callers. */
  handlerFailed: "HOLQA_HANDLER_FAILED",
  /** An invocation named a handler the runtime has not registered. */
  handlerNotFound: "HOLQA_HANDLER_NOT_FOUND",
  /** An invocation exceeded its time limit and was aborted. */
  invocationTimeout: "HOLQA_INVOCATION_TIMEOUT",
  /** An invocation was cancelled by its caller or by runtime shutdown. */
  invocationCancelled: "HOLQA_INVOCATION_CANCELLED",
  /** The runtime rejected an invocation because its concurrency limit and wait queue are full. */
  runtimeOverloaded: "HOLQA_RUNTIME_OVERLOADED",
  /** The runtime is not accepting invocations: it has not started, or it is stopping or stopped. */
  runtimeNotRunning: "HOLQA_RUNTIME_NOT_RUNNING",
  /** The runtime could not start an application, for example because two handlers serve the same route. */
  runtimeStartFailed: "HOLQA_RUNTIME_START_FAILED",
  /** A configuration value is missing or fails its schema. Secret values are never included. */
  configInvalid: "HOLQA_CONFIG_INVALID",
  /** An RPC request asks for a protocol version this runtime does not implement. */
  rpcVersionUnsupported: "HOLQA_RPC_VERSION_UNSUPPORTED",
  /** Build output no longer matches the application it was compiled from; rebuild it. */
  buildStale: "HOLQA_BUILD_STALE",
  /** A resource operation received invalid options, for example a negative delay or an out-of-range page size. */
  operationInvalid: "HOLQA_OPERATION_INVALID",
  /** An object key breaks the portable key rules. */
  objectKeyInvalid: "HOLQA_OBJECT_KEY_INVALID",
  /** A requested object does not exist. */
  objectNotFound: "HOLQA_OBJECT_NOT_FOUND",
  /** A signed URL is malformed, expired, or its signature does not match. */
  signedUrlInvalid: "HOLQA_SIGNED_URL_INVALID",
  /** A schedule's cron expression or time zone cannot be evaluated, or the schedule never fires. */
  scheduleInvalid: "HOLQA_SCHEDULE_INVALID",
  /** Local resource state was written by an incompatible version of the local drivers. */
  localStateUnsupported: "HOLQA_LOCAL_STATE_UNSUPPORTED",
  /** A delivery was received more often than its attempts allow without being settled, for example because its leases kept expiring. */
  deliveryAttemptsExhausted: "HOLQA_DELIVERY_ATTEMPTS_EXHAUSTED",
  /** A scheduled run was skipped because the previous run was still in progress and the schedule's overlap policy is `skip`. */
  scheduleRunSkipped: "HOLQA_SCHEDULE_RUN_SKIPPED",
  /** A development reload failed (the application no longer analyzes, builds or starts); the previous generation keeps serving. */
  reloadFailed: "HOLQA_RELOAD_FAILED",
  /** Another development session already runs the same application or uses the same local state directory. */
  devSessionActive: "HOLQA_DEV_SESSION_ACTIVE",
  /** The development supervisor could not start, for example because its port is in use. */
  devStartFailed: "HOLQA_DEV_START_FAILED",
  /** A file named on the command line does not exist or cannot be read. */
  fileUnreadable: "HOLQA_FILE_UNREADABLE",
  /** A `holqa doctor` check found a problem with the project or the local environment. */
  doctorCheckFailed: "HOLQA_DOCTOR_CHECK_FAILED",
  /** A local operation of the CLI (invoke, queue send, storage put, cron run, state) failed unexpectedly, for example because the process running the application exited. */
  localOperationFailed: "HOLQA_LOCAL_OPERATION_FAILED",
  /** Static analysis found handlers that may publish events which trigger themselves, directly or through other handlers. A warning, not an error: cycles may terminate. */
  eventCycle: "HOLQA_EVENT_CYCLE",
  /** An event was refused because it would be, or is, deeper in its causal chain than the receiving handler's `maxDepth`. Terminal: the event is not retried. */
  eventDepthExceeded: "HOLQA_EVENT_DEPTH_EXCEEDED",
  /** An invocation tried to publish more events than its `maxPublications` limit. Terminal for the delivery that ran it. */
  eventPublicationLimitExceeded: "HOLQA_EVENT_PUBLICATION_LIMIT_EXCEEDED",
  /** A delivery is older than `maxEventAgeMs` and was not delivered. Terminal: the event is not retried. */
  eventAgeExceeded: "HOLQA_EVENT_AGE_EXCEEDED",
  /** A root operation published more events than its per-operation budget allows. Terminal for the delivery that ran into it. */
  executionBudgetExceeded: "HOLQA_EXECUTION_BUDGET_EXCEEDED",
  /** Another delivery with the same idempotency key is being processed; this one is retried later. */
  idempotencyInProgress: "HOLQA_IDEMPOTENCY_IN_PROGRESS",
  /** A test application ran more invocations than its simulation budget allows, usually because of an event cycle. */
  simulationBudgetExceeded: "HOLQA_SIMULATION_BUDGET_EXCEEDED",
  /** Telemetry settings are invalid or ask for something unsupported, for example an OTLP protocol other than `http/json`. */
  telemetryConfigInvalid: "HOLQA_TELEMETRY_CONFIG_INVALID",
  /** A telemetry exporter rejected or timed out on a batch, or the export buffer was full; the records were dropped. Invocations are unaffected. */
  telemetryExportFailed: "HOLQA_TELEMETRY_EXPORT_FAILED",
  /** A trace, event or other telemetry record asked for by identifier was not found in the local telemetry store. */
  telemetryNotFound: "HOLQA_TELEMETRY_NOT_FOUND",
  /** A hot handler replacement named an unknown handler, named one twice, or changed a handler's definition; nothing was replaced. */
  handlerReplacementInvalid: "HOLQA_HANDLER_REPLACEMENT_INVALID",
  /** Messages already waiting in a local queue do not match the queue's changed message contract. A warning: the messages are kept. */
  queuedMessageIncompatible: "HOLQA_QUEUED_MESSAGE_INCOMPATIBLE",
  /** A binding's settings are malformed or contradictory, for example a non-numeric limit or an unknown option. Permanent: fix the binding configuration. */
  bindingConfigInvalid: "HOLQA_BINDING_CONFIG_INVALID",
  /** A credential a binding needs (for example a connection URL or an access key) is not set. Its value is never included. */
  bindingCredentialsMissing: "HOLQA_BINDING_CREDENTIALS_MISSING",
  /** Infrastructure rejected a binding's credentials, for example an authentication or authorization failure. Its value is never included. */
  bindingCredentialsInvalid: "HOLQA_BINDING_CREDENTIALS_INVALID",
  /** A provider implements a version of a binding contract (or of the provider protocol) this version of Holqa does not implement. */
  bindingContractIncompatible: "HOLQA_BINDING_CONTRACT_INCOMPATIBLE",
  /** Infrastructure a binding needs is temporarily unreachable, for example a broker that refuses connections. Transient: retrying later may succeed. */
  bindingUnavailable: "HOLQA_BINDING_UNAVAILABLE",
  /** A binding failed permanently, for example because a queue or bucket it connects to does not exist. Retrying does not help. */
  bindingFailed: "HOLQA_BINDING_FAILED",
  /** A binding configuration selects a provider for a resource the application does not declare. */
  bindingResourceUnknown: "HOLQA_BINDING_RESOURCE_UNKNOWN",
  /** A binding configuration selects a provider that does not bind the resource's kind, or a service provider that does not supply the service. */
  bindingKindMismatch: "HOLQA_BINDING_KIND_MISMATCH",
  /** No provider is selected for a declared resource. */
  bindingMissing: "HOLQA_BINDING_MISSING",
  /** A deployment's topology cannot deliver what the application needs, for example a provider that delivers no events for a resource with handlers, or a process-local scheduler with several replicas. */
  bindingTopologyUnsupported: "HOLQA_BINDING_TOPOLOGY_UNSUPPORTED",
  /** An extension definition, declaration or implementation is malformed. */
  extensionInvalid: "HOLQA_EXTENSION_INVALID",
  /** A required extension (or an extension another one depends on) has no implementation in the binding. */
  extensionMissing: "HOLQA_EXTENSION_MISSING",
  /** An extension is implemented in another version than the one used, or for a runtime the host does not run. */
  extensionIncompatible: "HOLQA_EXTENSION_INCOMPATIBLE",
  /** `holqa package` could not produce a deployment artifact, for example because bundling failed or a static site's directory is missing. */
  packageFailed: "HOLQA_PACKAGE_FAILED",
  /** A deployment artifact is incomplete or altered, or does not match what runs: a file's hash differs, a manifest is missing or malformed, or the binding resolved at start differs from the packaged binding manifest. */
  artifactInvalid: "HOLQA_ARTIFACT_INVALID",
  /** A container setting read from the environment (port, interface, shutdown periods) is invalid. */
  containerSettingsInvalid: "HOLQA_CONTAINER_SETTINGS_INVALID",
  /** A provisioning configuration or provisioner is malformed, for example a provisioner of another protocol version or two provisioners claiming one resource. */
  provisioningConfigInvalid: "HOLQA_PROVISIONING_CONFIG_INVALID",
  /** A provisioner failed to inspect or change infrastructure. Infrastructure changed before the failure stays changed; the result lists what was applied. */
  provisioningFailed: "HOLQA_PROVISIONING_FAILED",
  /** A plan contains a destructive change (`replace` or `delete`) that was not explicitly authorized, so nothing was applied. */
  provisioningDestructive: "HOLQA_PROVISIONING_DESTRUCTIVE"
} as const;

/**
 * Union of every known Holqa diagnostic code string.
 */
export type DiagnosticCode = (typeof diagnosticCodes)[keyof typeof diagnosticCodes];