import type { BindingReport } from "@holqa/bindings";
import type {
  EntrypointMap,
  EventAnalysis,
  Manifest
} from "@holqa/compiler";
import type { Diagnostic } from "@holqa/core";
import type {
  DeliveryHistory,
  LocalTelemetryReader
} from "@holqa/local";

import type { DevEvent } from "@/dev/events";
import type { PhaseResult } from "@/local/generation-process";
import type {
  DevRequest,
  DoctorRequest,
  OperateOutcome
} from "@/local/local-host";
import type { AppLocation } from "@/local/locations";
import type { DoctorCheck } from "@/local/operations";
import type { LocalOperation } from "@/local/protocol";

/** A successful analysis: the validated manifest, its entry points, and warnings. */
export interface AnalysisSuccess {
  readonly ok: true;
  readonly manifest: Manifest;
  readonly entrypoints: EntrypointMap;
  /**
   * The event dependency graph and its cycles. Locations are relative to the
   * application root. The process host always provides it; it is optional so
   * that hosts written before event analysis existed still type-check, and
   * `holqa inspect --cycles` reports `HOLQA_ANALYSIS_FAILED` without it.
   */
  readonly events?: EventAnalysis;
  /**
   * The binding configuration resolved and validated against the analyzed
   * application, when a bindings module was given. Its own `diagnostics`
   * (unmet requirements, missing providers) are separate from the analysis
   * diagnostics, which only report whether the module could be loaded.
   */
  readonly bindings?: BindingReport;
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

/** Settings of {@link CliHost.analyze}. */
export interface AnalyzeOptions {
  /** The absolute path of a binding configuration module (default export of `defineBindings`) to resolve against the application. */
  readonly bindingsPath?: string;
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
   * @param options - A binding configuration to resolve too. Hosts written before bindings existed ignore it and report no `bindings`.
   * @returns The analysis outcome; never rejects for problems in the application.
   */
  readonly analyze: (appPath: string, options?: AnalyzeOptions) => Promise<AnalysisOutcome>;
  /**
   * Writes a text file, creating missing parent directories.
   *
   * @param path - The absolute path of the file.
   * @param contents - The complete file contents.
   * @returns Resolves once the file is written; rejects when it cannot be.
   */
  readonly writeFile: (path: string, contents: string) => Promise<void>;
  /**
   * Reads a file named on the command line, for `holqa storage put`.
   * Optional; hosts without it cannot upload files.
   *
   * @param path - The absolute path.
   * @returns The bytes; rejects when the file cannot be read.
   */
  readonly readFile?: (path: string) => Promise<Uint8Array>;
  /**
   * Runs a dev session until the process is asked to stop. Runs the
   * application's code with the CLI's environment. Optional; hosts without it
   * report `holqa dev` as unavailable.
   */
  readonly dev?: (request: DevRequest, onEvent: (event: DevEvent) => void) => Promise<PhaseResult<undefined>>;
  /**
   * Runs one local operation: in the running dev session, or in a process
   * started for it. Optional; hosts without it report the operation commands
   * as unavailable.
   */
  readonly operate?: (location: AppLocation, operation: LocalOperation) => Promise<OperateOutcome>;
  /** Runs the checks of `holqa doctor`. Optional. */
  readonly doctor?: (request: DoctorRequest) => Promise<DoctorCheck[]>;
  /**
   * Opens the telemetry of a local state directory for reading, for
   * `holqa logs`, `traces`, `events inspect` and `metrics`. Optional; hosts
   * without it report those commands as unavailable.
   *
   * @param stateDir - The absolute state directory.
   * @returns The reader, or `undefined` when nothing was recorded there yet.
   */
  readonly telemetry?: (stateDir: string) => LocalTelemetryReader | undefined;
  /**
   * Reads what the local state records about one queue message or object
   * event, read-only. Optional; without it `holqa events inspect` shows only
   * telemetry.
   *
   * @param stateDir - The absolute state directory.
   * @param id - The message or event identifier.
   * @returns The history, or `undefined` when nothing has that identifier.
   */
  readonly deliveryHistory?: (stateDir: string, id: string) => DeliveryHistory | undefined;
  /**
   * Waits for an interval or until the process is asked to stop
   * (`SIGINT` or `SIGTERM`), for `holqa logs --follow`. Optional; without it
   * `--follow` is unavailable.
   *
   * @param intervalMs - How long to wait.
   * @returns `true` when the process was asked to stop, `false` when the interval passed.
   */
  readonly waitForStop?: (intervalMs: number) => Promise<boolean>;
  /**
   * The environment variables the application will start with, for
   * `holqa bindings validate` to check that credentials and configuration
   * values are set (never printed). Optional; without it the check is skipped.
   */
  readonly environment?: Readonly<Record<string, string | undefined>>;
}