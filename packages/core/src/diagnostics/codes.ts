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
  payloadVersionUnsupported: "HOLQA_PAYLOAD_VERSION_UNSUPPORTED"
} as const;

/**
 * Union of every known Holqa diagnostic code string.
 */
export type DiagnosticCode = (typeof diagnosticCodes)[keyof typeof diagnosticCodes];