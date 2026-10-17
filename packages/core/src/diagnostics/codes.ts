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
  manifestNotSerializable: "HOLQA_MANIFEST_NOT_SERIALIZABLE"
} as const;

/**
 * Union of every known Holqa diagnostic code string.
 */
export type DiagnosticCode = (typeof diagnosticCodes)[keyof typeof diagnosticCodes];