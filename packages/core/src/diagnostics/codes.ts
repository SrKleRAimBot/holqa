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
  bindingCapabilityUnsupported: "HOLQA_BINDING_CAPABILITY_UNSUPPORTED"
} as const;

/**
 * Union of every known Holqa diagnostic code string.
 */
export type DiagnosticCode = (typeof diagnosticCodes)[keyof typeof diagnosticCodes];