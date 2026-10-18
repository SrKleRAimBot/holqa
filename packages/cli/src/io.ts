/**
 * Output streams used by the CLI. Injected so that the CLI can be tested
 * without touching the real process streams.
 */
export interface CliIo {
  /** Writes text to standard output. */
  readonly stdout: (text: string) => void;
  /** Writes text to standard error. */
  readonly stderr: (text: string) => void;
}