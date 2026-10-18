import type {
  EntrypointMap,
  Manifest
} from "@holqa/compiler";
import type { Diagnostic } from "@holqa/core";

/** A successful analysis: the validated manifest, its entry points, and warnings. */
export interface AnalysisSuccess {
  readonly ok: true;
  readonly manifest: Manifest;
  readonly entrypoints: EntrypointMap;
  /** Warnings and information, sorted. Locations are relative to the application root. */
  readonly diagnostics: readonly Diagnostic[];
  /** Text the application's modules printed while they were evaluated. */
  readonly output: string;
}

/** A failed analysis: at least one error diagnostic, and no manifest. */
export interface AnalysisFailure {
  readonly ok: false;
  readonly diagnostics: readonly Diagnostic[];
  /** Text the application's modules printed while they were evaluated. */
  readonly output: string;
}

/** The outcome of analyzing an application. */
export type AnalysisOutcome = AnalysisSuccess | AnalysisFailure;

/**
 * Everything the CLI needs from its environment. Injected so the CLI can be
 * tested without spawning processes or touching the file system.
 */
export interface CliHost {
  /** The directory relative paths on the command line are resolved against. */
  readonly cwd: string;
  /**
   * Analyzes the application whose module is at `appPath`. Analysis evaluates
   * the application's modules, which runs their code.
   *
   * @param appPath - The absolute path of the application module, conventionally `infra.ts`.
   * @returns The analysis outcome; never rejects for problems in the application.
   */
  readonly analyze: (appPath: string) => Promise<AnalysisOutcome>;
  /**
   * Writes a text file, creating missing parent directories.
   *
   * @param path - The absolute path of the file.
   * @param contents - The complete file contents.
   * @returns Resolves once the file is written; rejects when it cannot be.
   */
  readonly writeFile: (path: string, contents: string) => Promise<void>;
}