import type { Diagnostic } from "@holqa/core";
import type { LocalTelemetryStore } from "@holqa/local";

import type { AnalysisOutcome } from "@/analysis/host";
import type { DevEvent } from "@/dev/events";
import type { PhaseResult } from "@/local/generation-process";
import type { AppLocation } from "@/local/locations";
import type { DoctorCheck } from "@/local/operations";
import type {
  LocalOperation,
  OperationResponse
} from "@/local/protocol";
import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  serializeEntrypoints,
  serializeManifest
} from "@holqa/compiler";
import {
  createDiagnostic,
  diagnosticCodes,
  frameworkMetrics
} from "@holqa/core";
import {
  createLocalTelemetryStore,
  readStateFormat,
  stateVersion
} from "@holqa/local";

import { displayPath } from "@/commands/analysis-command";
import {
  activeSession,
  readSession,
  sendToSession,
  stateLockPath
} from "@/dev/session";
import { DevSupervisor } from "@/dev/supervisor";
import { GenerationProcess } from "@/local/generation-process";
import { toJson } from "@/local/protocol";

/** What the local commands need from the CLI host. */
export interface LocalHostDependencies {
  readonly cwd: string;
  readonly analyze: (appPath: string) => Promise<AnalysisOutcome>;
  readonly writeFile: (path: string, contents: string) => Promise<void>;
  /** The application's environment. Defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/** Where an operation ran. `dev`: in the running dev session; `standalone`: in a process started for it. */
export type OperationTarget = "dev" | "standalone";

/** What an operation produced, and where. */
export interface OperateOutcome {
  readonly target: OperationTarget;
  readonly response: OperationResponse;
  /** What the application printed (standalone only). */
  readonly output: string;
  /** Analysis warnings (standalone only). */
  readonly warnings: readonly Diagnostic[];
}

/** Settings of a dev session. */
export interface DevRequest {
  readonly location: AppLocation;
  readonly port: number;
  readonly hostname: string;
  readonly watch: boolean;
  /** Whether implementation-only changes replace handlers in place. Default `true`. */
  readonly hot?: boolean;
  /** Whether to serve the development dashboard (only on loopback addresses). Default `true`. */
  readonly dashboard?: boolean;
  /** A binding configuration module to run with instead of the default local platform, absolute. */
  readonly bindings?: string;
}

/** Settings of `holqa doctor`. */
export interface DoctorRequest {
  readonly location: AppLocation;
  /** The port `holqa dev` would listen on. */
  readonly port: number;
  readonly hostname: string;
}

/**
 * Runs a dev session until the process receives `SIGINT` or `SIGTERM`.
 *
 * @param dependencies - Analysis, file writing and environment.
 * @param request - The application and address.
 * @param onEvent - Receives every event of the session.
 * @returns Success once the session stopped, or the diagnostics of a session that could not start.
 */
export async function runDevSession(dependencies: LocalHostDependencies, request: DevRequest, onEvent: (event: DevEvent) => void): Promise<PhaseResult<undefined>> {
  const store = openReloadMetrics(request.location.stateDir);
  const supervisor = new DevSupervisor({
    location: request.location,
    cwd: dependencies.cwd,
    port: request.port,
    hostname: request.hostname,
    watch: request.watch,
    ...request.hot === undefined ? {} : { hot: request.hot },
    ...request.dashboard === undefined ? {} : { dashboard: request.dashboard },
    analyze: dependencies.analyze,
    writeFile: dependencies.writeFile,
    onEvent: (event) => {
      // Reload failures are a framework metric; `holqa metrics` reads them from the telemetry store.
      if (event.type === "build.failed" || event.type === "generation.failed")
        store?.increment(frameworkMetrics.reloadFailures, { "holqa.reload.stage": event.type === "build.failed" ? "build" : "start" });
      onEvent(event);
    },
    ...dependencies.env === undefined ? {} : { env: dependencies.env },
    ...request.bindings === undefined ? {} : { bindingsModule: request.bindings }
  });
  let signalled!: () => void;
  const stopped = new Promise<void>((resolve) => {
    signalled = resolve;
  });
  process.once("SIGINT", signalled);
  process.once("SIGTERM", signalled);
  try {
    const started = await supervisor.start();
    if (!started.ok) {
      await supervisor.stop();
      return started;
    }
    await stopped;
    await supervisor.stop();
    return { ok: true, value: undefined };
  } finally {
    process.off("SIGINT", signalled);
    process.off("SIGTERM", signalled);
    store?.close();
  }
}

/**
 * Opens the telemetry store the dev session counts reload failures in.
 * Telemetry never stops a session: when the store cannot be opened, reload
 * failures are only reported, not counted.
 *
 * @param stateDir - The local state directory.
 * @returns The store, or `undefined` when it cannot be opened.
 */
function openReloadMetrics(stateDir: string): LocalTelemetryStore | undefined {
  try {
    return createLocalTelemetryStore({ directory: stateDir });
  } catch (error) {
    process.stderr.write(`holqa: reload failures are not counted: the telemetry store could not be opened (${error instanceof Error ? error.message : String(error)}).\n`);
    return undefined;
  }
}

/**
 * Runs one operation: in the application's running dev session when there is
 * one for the same state directory, otherwise in a process started for it,
 * after analyzing and building the application.
 *
 * @param dependencies - Analysis, file writing and environment.
 * @param requested - The application and state directory from the command line.
 * @param operation - The operation to run.
 * @returns The response and where it ran.
 */
export async function operateLocally(dependencies: LocalHostDependencies, requested: AppLocation, operation: LocalOperation): Promise<OperateOutcome> {
  const session = activeSession(requested.sessionPath) ?? activeSession(stateLockPath(requested.stateDir));
  if (session !== undefined) {
    if (session.stateDir !== requested.stateDir)
      return { target: "dev", response: { ok: false, diagnostics: [createDiagnostic({ code: diagnosticCodes.devSessionActive, severity: "error", message: `holqa dev runs for this application at ${session.url} with the state directory "${displayPath(dependencies.cwd, session.stateDir)}".`, hint: "Pass the session's --state-dir, or stop the session first." })] }, output: "", warnings: [] };

    const response = await sendToSession(session, operation, 130_000);
    // Never fall back to another process while the session lives: the operation may already have run.
    return { target: "dev", response: response ?? { ok: false, diagnostics: [createDiagnostic({ code: diagnosticCodes.localOperationFailed, severity: "error", message: `The dev session at ${session.url} (process ${session.pid}) did not answer; the operation may or may not have run.`, hint: "Check the session's output, or stop it and run the command again." })] }, output: "", warnings: [] };
  }
  // A build directory of its own, so a session starting meanwhile never loads a half-written build.
  const location = { ...requested, buildDir: join(requested.root, ".holqa", "dev", "operation-build") };
  const outcome = await dependencies.analyze(location.appPath);
  const located = locate(dependencies.cwd, location.root, outcome.diagnostics);
  if (!outcome.ok)
    return { target: "standalone", response: { ok: false, diagnostics: located }, output: outcome.output, warnings: [] };
  try {
    await dependencies.writeFile(join(location.buildDir, "manifest.json"), `${serializeManifest(outcome.manifest)}\n`);
    await dependencies.writeFile(join(location.buildDir, "entrypoints.json"), `${serializeEntrypoints(outcome.entrypoints)}\n`);
  } catch (error) {
    return { target: "standalone", response: { ok: false, diagnostics: [createDiagnostic({ code: diagnosticCodes.buildOutputFailed, severity: "error", message: `Could not write the build to "${displayPath(dependencies.cwd, location.buildDir)}": ${error instanceof Error ? error.message : String(error)}` })] }, output: outcome.output, warnings: located };
  }
  const lines: string[] = [];
  const child = GenerationProcess.spawn({
    request: { mode: "once", root: location.root, buildDir: location.buildDir, stateDir: location.stateDir, publicOrigin: "http://127.0.0.1:3000", generation: 0 },
    ...dependencies.env === undefined ? {} : { env: dependencies.env },
    onOutput: (_stream, line) => lines.push(line)
  });
  const response = await child.operate(operation, 120_000);
  const timer = setTimeout(() => void child.kill(), 10_000);
  await child.exited;
  clearTimeout(timer);
  return { target: "standalone", response, output: [outcome.output.trimEnd(), ...lines].filter(line => line !== "").join("\n"), warnings: located };
}

/**
 * Checks the project and the local environment: the Bun version, the
 * application, its analysis, configuration and capabilities, the local
 * state, the dev session and the dev port. Never modifies the local state.
 *
 * @param dependencies - Analysis, file writing and environment.
 * @param request - The application and the dev address.
 * @returns The checks, in order.
 */
export async function runDoctor(dependencies: LocalHostDependencies, request: DoctorRequest): Promise<DoctorCheck[]> {
  const { location } = request;
  const checks: DoctorCheck[] = [checkBun()];
  if (!existsSync(location.appPath)) {
    checks.push({ name: "application", status: "error", message: `The application module "${displayPath(dependencies.cwd, location.appPath)}" does not exist.`, diagnostics: toJson([createDiagnostic({ code: diagnosticCodes.appNotFound, severity: "error", message: "The application module does not exist.", hint: "Run the command in the directory that contains infra.ts, or pass --app <path>." })]) });
    return checks;
  }
  checks.push({ name: "application", status: "ok", message: `Found ${displayPath(dependencies.cwd, location.appPath)}.` });
  const outcome = await dependencies.analyze(location.appPath);
  const located = locate(dependencies.cwd, location.root, outcome.diagnostics);
  if (!outcome.ok) {
    checks.push({ name: "analysis", status: "error", message: "The application does not analyze.", diagnostics: toJson(located) });
  } else {
    checks.push({ name: "analysis", status: located.length > 0 ? "warning" : "ok", message: `"${outcome.manifest.application.name}" declares ${outcome.manifest.resources.length} resources and ${outcome.manifest.handlers.length} handlers.`, ...located.length > 0 ? { diagnostics: toJson(located) } : {} });
    const scratchBuild = { ...location, buildDir: join(location.root, ".holqa", "dev", "doctor-build") };
    const result = await operateStandalone(dependencies, scratchBuild, outcome);
    if (result.ok) {
      const { checks: nested } = result.result;
      if (Array.isArray(nested))
        checks.push(...nested as DoctorCheck[]);
    } else {
      checks.push({ name: "configuration", status: "error", message: "The application could not be loaded with the local binding.", diagnostics: toJson(result.diagnostics) });
    }
  }
  checks.push(checkState(dependencies.cwd, location.stateDir));
  checks.push(...await checkSession(location, request));
  return checks;
}

/**
 * Runs the doctor operation in a process started for it.
 *
 * @param dependencies - File writing and environment.
 * @param location - The application, with the build directory to use.
 * @param outcome - The successful analysis.
 * @returns The operation's response.
 */
async function operateStandalone(dependencies: LocalHostDependencies, location: AppLocation, outcome: AnalysisOutcome & { readonly ok: true }): Promise<OperationResponse> {
  await dependencies.writeFile(join(location.buildDir, "manifest.json"), `${serializeManifest(outcome.manifest)}\n`);
  await dependencies.writeFile(join(location.buildDir, "entrypoints.json"), `${serializeEntrypoints(outcome.entrypoints)}\n`);
  const child = GenerationProcess.spawn({
    request: { mode: "once", root: location.root, buildDir: location.buildDir, stateDir: location.stateDir, publicOrigin: "http://127.0.0.1:3000", generation: 0 },
    ...dependencies.env === undefined ? {} : { env: dependencies.env }
  });
  const response = await child.operate({ kind: "doctor" }, 60_000);
  await Promise.race([child.exited, new Promise(resolve => setTimeout(resolve, 5_000))]);
  await child.kill();
  return response;
}

/**
 * Compares the running Bun version with the one the CLI requires.
 *
 * @returns `ok` when Bun is recent enough, otherwise an error.
 */
function checkBun(): DoctorCheck {
  const required = "1.3.13";
  const running = typeof Bun === "undefined" ? undefined : Bun.version;
  if (running === undefined)
    return { name: "bun", status: "error", message: "holqa runs on Bun, but no Bun runtime was detected." };
  /**
   * Compares two version strings by their first three numbers.
   *
   * @param left - One version.
   * @param right - Another version.
   * @returns A negative number when `left` is older.
   */
  const compare = (left: string, right: string): number => {
    const [a, b] = [left, right].map(version => version.split(/[.-]/).slice(0, 3).map(Number));
    for (let index = 0; index < 3; index += 1) {
      const difference = (a![index] ?? 0) - (b![index] ?? 0);
      if (difference !== 0)
        return difference;
    }
    return 0;
  };
  return compare(running, required) >= 0
    ? { name: "bun", status: "ok", message: `Bun ${running} (at least ${required} is required).` }
    : { name: "bun", status: "error", message: `Bun ${running} is older than the required ${required}.`, diagnostics: toJson([createDiagnostic({ code: diagnosticCodes.doctorCheckFailed, severity: "error", message: `Bun ${running} is too old.`, hint: `Install Bun ${required} or later.` })]) };
}

/**
 * Checks the local state directory without modifying it.
 *
 * @param cwd - The working directory, for display.
 * @param stateDir - The state directory.
 * @returns `ok` for missing, current or upgradable state; an error for unreadable or newer state.
 */
function checkState(cwd: string, stateDir: string): DoctorCheck {
  const shown = displayPath(cwd, stateDir);
  let version: number | undefined;
  try {
    version = readStateFormat(stateDir);
  } catch (error) {
    return { name: "state", status: "error", message: `The local state in ${shown} cannot be read: ${error instanceof Error ? error.message : String(error)}`, diagnostics: toJson([createDiagnostic({ code: diagnosticCodes.doctorCheckFailed, severity: "error", message: "The local state cannot be read.", hint: "Move the state directory away to start with fresh local state." })]) };
  }
  if (version === undefined)
    return { name: "state", status: "ok", message: `No local state yet; it will be created in ${shown}.` };
  if (version > stateVersion)
    return { name: "state", status: "error", message: `The local state in ${shown} has format ${version}; this version reads format ${stateVersion}.`, diagnostics: toJson([createDiagnostic({ code: diagnosticCodes.localStateUnsupported, severity: "error", message: `The local state has format ${version}.`, hint: "Use the Holqa version that wrote it, or point --state-dir at a new directory." })]) };
  if (version < stateVersion)
    return { name: "state", status: "ok", message: `The local state in ${shown} has format ${version}; it is upgraded to format ${stateVersion} when the application next runs.` };
  return { name: "state", status: "ok", message: `Local state in ${shown}, format ${version}.` };
}

/**
 * Checks for a dev session and whether the dev port is free.
 *
 * @param location - The application.
 * @param request - The dev address.
 * @returns The checks.
 */
async function checkSession(location: AppLocation, request: DoctorRequest): Promise<DoctorCheck[]> {
  const active = activeSession(location.sessionPath);
  if (active !== undefined)
    return [{ name: "session", status: "ok", message: `holqa dev is running at ${active.url} (process ${active.pid}); operation commands use it.` }];
  const stale = readSession(location.sessionPath);
  const checks: DoctorCheck[] = [stale === undefined
    ? { name: "session", status: "ok", message: "No dev session is running; operation commands start the application for each operation." }
    : { name: "session", status: "warning", message: `A session file of a process that no longer runs (${stale.pid}) was found; the next holqa dev replaces it.` }];
  try {
    const probe = Bun.serve({ port: request.port, hostname: request.hostname, fetch: () => new Response(null) });
    await probe.stop(true);
    checks.push({ name: "port", status: "ok", message: `Port ${request.port} on ${request.hostname} is free for holqa dev.` });
  } catch {
    checks.push({ name: "port", status: "warning", message: `Port ${request.port} on ${request.hostname} is in use; run holqa dev with --port <number>, or --port 0 for any free port.` });
  }
  return checks;
}

/**
 * Rewrites diagnostic locations, which are relative to the application root, for display.
 *
 * @param cwd - The working directory.
 * @param root - The application root.
 * @param diagnostics - Diagnostics whose locations are relative to the root.
 * @returns The diagnostics with displayable locations.
 */
function locate(cwd: string, root: string, diagnostics: readonly Diagnostic[]): Diagnostic[] {
  return diagnostics.map(diagnostic => diagnostic.location === undefined
    ? diagnostic
    : createDiagnostic({ ...diagnostic, location: { ...diagnostic.location, file: displayPath(cwd, join(root, diagnostic.location.file)) } }));
}