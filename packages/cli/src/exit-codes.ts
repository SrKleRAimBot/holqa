/**
 * Process exit codes returned by `runCli`.
 */
export const exitCodes = {
  success: 0,
  /** The command was understood but failed or is unavailable. */
  failure: 1,
  /** The command line could not be understood. */
  usage: 2
} as const;