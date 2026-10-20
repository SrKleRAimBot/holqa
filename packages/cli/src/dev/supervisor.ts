import type {
  EntrypointMap,
  Manifest
} from "@holqa/compiler";
import type {
  Diagnostic,
  JsonObject,
  JsonValue
} from "@holqa/core";
import type { Server } from "bun";

import type { AnalysisOutcome } from "@/analysis/host";
import type { ManifestChange } from "@/dev/classify";
import type { DashboardSource } from "@/dev/dashboard";
import type { DevEvent } from "@/dev/events";
import type { ModuleGraph } from "@/dev/module-graph";
import type { ReloadPlan } from "@/dev/reload-plan";
import type {
  GenerationProcessOptions,
  PhaseResult
} from "@/local/generation-process";
import type { SwapVersion } from "@/local/hot-swap";
import type { AppLocation } from "@/local/locations";
import type { OperationResponse } from "@/local/protocol";
import {
  randomBytes,
  timingSafeEqual
} from "node:crypto";
import {
  join,
  relative,
  sep
} from "node:path";

import {
  serializeEntrypoints,
  serializeManifest
} from "@holqa/compiler";
import {
  createDiagnostic,
  diagnosticCodes
} from "@holqa/core";
import { openLocalTelemetryReader } from "@holqa/local";

import { displayPath } from "@/commands/analysis-command";
import { classifyChange } from "@/dev/classify";
import {
  dashboardPath,
  isLoopbackHost,
  serveDashboard
} from "@/dev/dashboard";
import { summarize } from "@/dev/events";
import { buildModuleGraph } from "@/dev/module-graph";
import {
  planReload,
  sharedModules
} from "@/dev/reload-plan";
import {
  activeSession,
  operationsPath,
  removeSession,
  sessionFormat,
  stateLockPath,
  writeSession
} from "@/dev/session";
import {
  isEnvironmentFile,
  watchFiles
} from "@/dev/watcher";
import { GenerationProcess } from "@/local/generation-process";
import { readOperation } from "@/local/protocol";

/** Time limits of a dev session, in milliseconds. */
export interface SupervisorTimeouts {
  /** Loading and checking a new generation. Default 30 000. */
  readonly prepareMs?: number;
  /** Starting a prepared generation. Default 30 000. */
  readonly activateMs?: number;
  /** Stopping a generation before it is killed. Default 10 000. */
  readonly stopMs?: number;
  /** How long a request waits for a generation that is starting. Default 15 000. */
  readonly requestWaitMs?: number;
  /** How long an operation may take. Default 120 000. */
  readonly operationMs?: number;
  /** How long a handler replacement may take. Default 30 000. */
  readonly swapMs?: number;
}

/** Settings of a {@link DevSupervisor}. */
export interface SupervisorOptions {
  readonly location: AppLocation;
  /** The working directory, for paths in diagnostics. */
  readonly cwd: string;
  readonly port: number;
  readonly hostname: string;
  /** Whether to rebuild when files change. */
  readonly watch: boolean;
  /** Analyzes the application; the CLI's isolated analysis process. */
  readonly analyze: (appPath: string) => Promise<AnalysisOutcome>;
  readonly writeFile: (path: string, contents: string) => Promise<void>;
  /** Receives every event of the session. Must not throw. */
  readonly onEvent: (event: DevEvent) => void;
  /** The application's environment. Defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** A binding configuration module (`--bindings`), absolute; absent runs the default local platform. Changing it restarts the application. */
  readonly bindingsModule?: string;
  /** Starts generation processes; replaceable in tests. */
  readonly spawn?: (options: GenerationProcessOptions) => GenerationProcess;
  readonly timeouts?: SupervisorTimeouts;
  /** Watch debounce period in milliseconds. Default 100. */
  readonly debounceMs?: number;
  /**
   * Whether implementation-only changes replace handlers in the running
   * process instead of restarting it. Default `true`. With `false`, every
   * change restarts the generation process (the fallback path).
   */
  readonly hot?: boolean;
  /** After how many replacements a generation process is restarted, to release old module copies. Default 50. */
  readonly maxSwaps?: number;
  /**
   * Whether to serve the read-only development dashboard at
   * `/_holqa/dashboard`. Default `true`. It is only served when the session
   * listens on a loopback address.
   */
  readonly dashboard?: boolean;
}

/** A successful build: what the next generation loads. */
interface Build {
  readonly manifest: Manifest;
  readonly entrypoints: EntrypointMap;
}

/** The generation that serves requests. */
interface Current {
  readonly generation: number;
  readonly process: GenerationProcess;
  readonly port: number;
  /** What it runs; reloads are classified against it. */
  build: Build;
  /** How many handler replacements it made. */
  swaps: number;
  /** Its handlers' versions after the last replacement; empty before the first. */
  versions: readonly SwapVersion[];
}

/** Why the running code is behind the source files. */
export interface StaleState {
  /** When the running code became stale (ISO 8601). */
  readonly since: string;
  /** The changed files the running code does not include. */
  readonly files: readonly string[];
  readonly diagnostics: readonly Diagnostic[];
}

/** One reload, as the session remembers it for its dashboard. */
export interface ReloadRecord {
  /** When it finished (ISO 8601). */
  readonly at: string;
  readonly files: readonly string[];
  /** `swapped`: handlers replaced in place; `restarted`: a new generation serves; `failed`: the running code is unchanged. */
  readonly outcome: "swapped" | "restarted" | "failed";
  /** The plan, when the build succeeded. */
  readonly plan?: ReloadPlan;
  readonly generation?: number;
  /** The handler registry version after a replacement. */
  readonly version?: number;
  readonly durationMs: number;
  readonly diagnostics: readonly Diagnostic[];
}

/** Counters of a session, for tests and diagnostics. */
export interface SupervisorStats {
  /** The generation serving requests, if any. */
  readonly serving: number | undefined;
  /** How many generation processes were started. */
  readonly started: number;
  /** How many generation processes are alive now. */
  readonly alive: number;
  /** How many handler replacements succeeded in the session. */
  readonly swaps: number;
}

/**
 * Supervises one `holqa dev` session.
 *
 * The session owns a stable HTTP address and proxies requests to the current
 * generation: one process that runs the application on Bun with the local
 * drivers. A reload analyzes the application, writes the build, and starts a
 * new generation in two phases. In the first, the new process loads every
 * module, creates its runtime and checks configuration and capabilities while
 * the old generation keeps serving; any failure there leaves the old one
 * running. Only then is the old generation stopped (draining in-flight work
 * and settling deliveries), and the new one starts consuming and serving.
 * Exactly one generation consumes queues, events and schedules at any time,
 * so restarts never duplicate consumers, and each generation is a fresh
 * process, so no module state, listener or timer survives a reload.
 */
export class DevSupervisor {
  /** Settings. */
  private readonly options: SupervisorOptions;
  /** The bearer token of the control endpoint. */
  private readonly token = randomBytes(32).toString("hex");
  /** The proxy server. */
  private server: Server<undefined> | undefined;
  /** Stops watching. */
  private unwatch: (() => void) | undefined;
  /** The serving generation. */
  private current: Current | undefined;
  /** The generation being started, so a stop can kill it. */
  private starting: GenerationProcess | undefined;
  /** The last successful build. */
  private built: Build | undefined;
  /** Why no generation serves, when one failed. */
  private failure: readonly Diagnostic[] | undefined;
  /** Waiters for a serving generation. */
  private waiters: Array<() => void> = [];
  /** Files changed since the last rebuild began. */
  private readonly changed = new Set<string>();
  /** Whether another rebuild is due. */
  private rebuildDue = false;
  /** The running rebuild loop. */
  private loop: Promise<void> | undefined;
  /** Generation numbers. */
  private generations = 0;
  /** Processes started. */
  private started = 0;
  /** Processes alive. */
  private alive = 0;
  /** Set once the session stops. */
  private stopping: Promise<void> | undefined;
  /** Successful handler replacements. */
  private swaps = 0;
  /** Why the running code is behind, if it is. */
  private staleState: StaleState | undefined;
  /** The most recent reloads, oldest first. */
  private readonly reloads: ReloadRecord[] = [];
  /** The most recent log entries of the serving generations, oldest first, for the dashboard. */
  private readonly recentLogs: JsonObject[] = [];
  /** The warnings of the last successful build, for the dashboard. */
  private buildDiagnostics: readonly Diagnostic[] = [];

  /**
   * Creates a supervisor; nothing runs until {@link start}.
   *
   * @param options - The application, address, analysis and event sink.
   */
  constructor(options: SupervisorOptions) {
    this.options = options;
  }

  /** The session's address, once listening. */
  get url(): string | undefined {
    return this.server?.url.href;
  }

  /**
   * Returns the session's counters.
   *
   * @returns A snapshot.
   */
  stats(): SupervisorStats {
    return { serving: this.current?.generation, started: this.started, alive: this.alive, swaps: this.swaps };
  }

  /**
   * Describes what the session runs, for its dashboard: the serving
   * generation and its handler versions, whether the running code is stale,
   * and the most recent reloads.
   *
   * @returns A JSON-compatible snapshot.
   */
  status(): { readonly url: string | undefined; readonly hot: boolean; readonly serving?: { readonly generation: number; readonly pid: number; readonly swaps: number; readonly versions: readonly SwapVersion[] }; readonly stale?: StaleState; readonly summary?: ReturnType<typeof summarize>; readonly reloads: readonly ReloadRecord[]; readonly diagnostics: readonly Diagnostic[] } {
    const current = this.current;
    return {
      url: this.url,
      hot: this.options.hot ?? true,
      diagnostics: this.buildDiagnostics,
      ...current === undefined ? {} : { serving: { generation: current.generation, pid: current.process.pid, swaps: current.swaps, versions: current.versions } },
      ...this.staleState === undefined ? {} : { stale: this.staleState },
      ...current === undefined ? {} : { summary: summarize(current.build.manifest, current.build.entrypoints, Date.now()) },
      reloads: [...this.reloads]
    };
  }

  /**
   * Starts the session: refuses a second session for the same application,
   * listens, records the session file, builds and starts the first
   * generation, and starts watching. A failing first build does not fail the
   * session: it is reported, and the next change rebuilds.
   *
   * @returns The session's URL, or `HOLQA_DEV_SESSION_ACTIVE` / `HOLQA_DEV_START_FAILED`.
   */
  async start(): Promise<PhaseResult<string>> {
    const { location } = this.options;
    const existing = activeSession(location.sessionPath) ?? activeSession(stateLockPath(location.stateDir));
    if (existing !== undefined) {
      return failed(createDiagnostic({
        code: diagnosticCodes.devSessionActive,
        severity: "error",
        message: `holqa dev is already running for this application or its state directory at ${existing.url} (process ${existing.pid}).`,
        hint: "Stop the other session, or use it: the operation commands (invoke, queue send, ...) send their work to it."
      }));
    }
    try {
      this.server = Bun.serve({ port: this.options.port, hostname: this.options.hostname, maxRequestBodySize: 100 * 1024 * 1024, idleTimeout: 120, fetch: request => this.handle(request) });
    } catch (error) {
      return failed(createDiagnostic({
        code: diagnosticCodes.devStartFailed,
        severity: "error",
        message: `holqa dev could not listen on ${this.options.hostname}:${this.options.port}: ${error instanceof Error ? error.message : String(error)}`,
        hint: "Another process may use the port. Choose another with --port, or --port 0 for any free port."
      }));
    }
    const url = this.server.url.href;
    const session = { format: sessionFormat, pid: process.pid, url, token: this.token, stateDir: location.stateDir, startedAt: new Date().toISOString() } as const;
    writeSession(location.sessionPath, session);
    writeSession(stateLockPath(location.stateDir), session);
    const dashboard = this.dashboardEnabled() ? new URL(dashboardPath, url).href : undefined;
    this.emit({ type: "dev.listening", url, stateDirectory: this.path(location.stateDir), buildDirectory: this.path(location.buildDir), watching: this.options.watch, hot: this.options.hot ?? true, ...dashboard === undefined ? {} : { dashboard } });
    if (this.options.watch) {
      this.unwatch = watchFiles({
        root: location.root,
        debounceMs: this.options.debounceMs ?? 100,
        onChange: files => void this.reload(files),
        onError: error => this.emit({ type: "build.failed", diagnostics: [createDiagnostic({ code: diagnosticCodes.reloadFailed, severity: "error", message: `Watching files failed: ${error instanceof Error ? error.message : String(error)}. Restart holqa dev.` })], ...this.serving() })
      });
    }
    await this.reload([]);
    return { ok: true, value: url };
  }

  /**
   * Requests a rebuild. Rebuilds are serialized: changes that arrive while one
   * runs are collected and handled by one more rebuild afterwards.
   *
   * @param files - The changed files, relative to the application root; empty for the first build.
   * @returns A promise that settles once no rebuild is pending.
   */
  reload(files: readonly string[]): Promise<void> {
    if (this.stopping !== undefined)
      return Promise.resolve();
    for (const file of files)
      this.changed.add(file);
    this.rebuildDue = true;
    this.loop ??= (async () => {
      while (this.rebuildDue && this.stopping === undefined) {
        this.rebuildDue = false;
        const batch = [...this.changed].sort();
        this.changed.clear();
        await this.rebuild(batch);
      }
    })().finally(() => {
      this.loop = undefined;
    });
    return this.loop;
  }

  /**
   * Stops the session: stops watching, stops the serving generation
   * gracefully, closes the server and removes the session file. Idempotent.
   *
   * @returns A promise that settles once everything stopped.
   */
  stop(): Promise<void> {
    this.stopping ??= (async () => {
      this.unwatch?.();
      await this.starting?.kill();
      const current = this.current;
      this.current = undefined;
      if (current !== undefined) {
        const exitCode = await current.process.stop(this.timeout("stopMs", 10_000));
        this.emit({ type: "generation.stopped", generation: current.generation, exitCode });
      }
      this.release();
      await this.server?.stop(true);
      removeSession(this.options.location.sessionPath, this.token);
      removeSession(stateLockPath(this.options.location.stateDir), this.token);
      this.emit({ type: "dev.stopped" });
    })();
    return this.stopping;
  }

  /**
   * Rebuilds after a change and replaces the generation.
   *
   * @param files - The changed files.
   */
  private async rebuild(files: readonly string[]): Promise<void> {
    const started = performance.now();
    if (files.length > 0)
      this.emit({ type: "change", files });
    let build = this.built;
    let change: ManifestChange;
    let diagnostics: readonly Diagnostic[] = [];
    let graph: ModuleGraph | undefined;
    if (build !== undefined && files.length > 0 && files.every(isEnvironmentFile)) {
      // Only `.env` files changed: the analysis never sees them, so only the application process restarts.
      change = { kind: "environment", resources: { added: [], removed: [], changed: [] }, handlers: { added: [], removed: [], changed: [] }, config: { added: [], removed: [], changed: [] }, contracts: [] };
    } else {
      const outcome = await this.options.analyze(this.options.location.appPath);
      for (const line of outcome.output.split("\n").filter(text => text !== ""))
        this.emit({ type: "output", generation: this.generations + 1, stream: "stderr", line });
      if (!outcome.ok) {
        const failure = [this.reloadFailed("The application no longer analyzes."), ...this.located(outcome.diagnostics)];
        this.markStale(files, failure);
        this.fail("build.failed", undefined, failure);
        this.remember({ files, outcome: "failed", durationMs: Math.round(performance.now() - started), diagnostics: failure });
        return;
      }
      const { manifest, entrypoints } = outcome;
      // Compare with what runs, not with a build that failed to start: queued messages were written under the running contracts.
      change = classifyChange(this.current?.build.manifest ?? this.built?.manifest, manifest);
      diagnostics = [...this.located(outcome.diagnostics), ...change.contracts];
      this.buildDiagnostics = diagnostics;
      build = { manifest, entrypoints };
      if (this.options.hot ?? true)
        graph = this.graph(entrypoints);
    }
    // Files whose changes never reached the running code are planned again, so a later swap cannot leave them stale.
    const pending = [...new Set([...files, ...this.staleState?.files ?? []])].sort();
    let plan = planReload({
      files: pending,
      change,
      hot: this.options.hot ?? true,
      serving: this.current !== undefined,
      previous: this.current?.build.entrypoints,
      next: build?.entrypoints,
      graph,
      swaps: this.current?.swaps ?? 0,
      maxSwaps: this.options.maxSwaps ?? 50,
      ...this.options.bindingsModule === undefined ? {} : { bindingsModule: relative(this.options.location.root, this.options.bindingsModule).split(sep).join("/") }
    });
    if (plan.strategy === "swap" && this.current !== undefined && graph !== undefined) {
      // The manifest and entry point map are unchanged, so the build on disk stays valid: nothing is rewritten.
      this.emit({ type: "build", generation: this.current.generation, change, fingerprint: build!.entrypoints.manifest, durationMs: Math.round(performance.now() - started), diagnostics, reload: plan });
      const fallback = await this.swap(this.current, build!, plan, graph, files, started);
      if (fallback === undefined)
        return;
      // The change cannot be applied in place: restart instead, with the plan that says why.
      plan = fallback;
    }
    if (change.kind !== "environment" && !await this.write(build!))
      return;
    this.built = build;
    const generation = ++this.generations;
    if (plan.strategy === "restart")
      this.emit({ type: "build", generation, change, fingerprint: build!.entrypoints.manifest, durationMs: Math.round(performance.now() - started), diagnostics, reload: plan });
    const revalidate = change.resources.changed.filter(entry => entry.startsWith("queue ")).map(entry => entry.slice("queue ".length));
    await this.replace(generation, build!, started, files, plan.strategy === "restart" ? plan : undefined, revalidate);
  }

  /**
   * Writes a build for the next generation process.
   *
   * @param build - The manifest and entry point map.
   * @returns `true` once written; `false` after reporting a failure.
   */
  private async write(build: Build): Promise<boolean> {
    try {
      await this.options.writeFile(join(this.options.location.buildDir, "manifest.json"), `${serializeManifest(build.manifest)}\n`);
      await this.options.writeFile(join(this.options.location.buildDir, "entrypoints.json"), `${serializeEntrypoints(build.entrypoints)}\n`);
      return true;
    } catch (error) {
      this.fail("build.failed", undefined, [createDiagnostic({ code: diagnosticCodes.buildOutputFailed, severity: "error", message: `Could not write the dev build to "${this.path(this.options.location.buildDir)}": ${error instanceof Error ? error.message : String(error)}` })]);
      return false;
    }
  }

  /**
   * Builds the import graph of the application and its handler modules.
   *
   * @param entrypoints - The entry point map of the new build.
   * @returns The imports of every application module the build reaches.
   */
  private graph(entrypoints: EntrypointMap): ModuleGraph {
    const { root } = this.options.location;
    return buildModuleGraph(root, [entrypoints.application.module, ...entrypoints.handlers.map(entry => entry.module)].map(module => join(root, module)));
  }

  /**
   * Replaces handlers in the serving generation.
   *
   * @param current - The serving generation.
   * @param build - The new build (same manifest and entry point map).
   * @param plan - The modules and handlers to replace.
   * @param graph - The import graph, for the modules to share.
   * @param files - The changed files.
   * @param started - When the rebuild began.
   * @returns `undefined` when the reload is finished (replaced, or failed with the old code serving); otherwise the restart plan that replaces it.
   */
  private async swap(current: Current, build: Build, plan: Extract<ReloadPlan, { readonly strategy: "swap" }>, graph: ModuleGraph, files: readonly string[], started: number): Promise<ReloadPlan | undefined> {
    const outcome = await current.process.swap({ modules: plan.modules, shared: sharedModules(graph, build.entrypoints.application.module) }, this.timeout("swapMs", 30_000));
    const durationMs = Math.round(performance.now() - started);
    if (outcome.ok) {
      current.swaps += 1;
      current.versions = outcome.versions;
      current.build = build;
      this.built = build;
      this.swaps += 1;
      this.staleState = undefined;
      this.emit({ type: "handlers.swapped", generation: current.generation, version: outcome.version, handlers: outcome.handlers, modules: plan.modules, durationMs, versions: outcome.versions });
      this.remember({ files, outcome: "swapped", plan, generation: current.generation, version: outcome.version, durationMs, diagnostics: [] });
      return undefined;
    }
    if (outcome.restart) {
      const reason = outcome.reason ?? "replacement-rejected";
      const diagnostics = this.located(outcome.diagnostics);
      this.emit({ type: "handlers.swap-refused", generation: current.generation, reason, diagnostics });
      return { strategy: "restart", reason, detail: diagnostics[0]?.message ?? "The handlers could not be replaced in place." };
    }
    const failure = [this.reloadFailed("The changed handlers could not be loaded."), ...this.located(outcome.diagnostics)];
    this.markStale(files, failure);
    this.emit({ type: "handlers.swap-failed", generation: current.generation, diagnostics: failure, serving: current.generation, stale: true });
    this.remember({ files, outcome: "failed", plan, generation: current.generation, durationMs, diagnostics: failure });
    return undefined;
  }

  /**
   * Records that the running code does not include some changes.
   *
   * @param files - The changed files.
   * @param diagnostics - Why.
   */
  private markStale(files: readonly string[], diagnostics: readonly Diagnostic[]): void {
    if (this.current === undefined)
      return;
    const previous = this.staleState?.files ?? [];
    this.staleState = { since: this.staleState?.since ?? new Date().toISOString(), files: [...new Set([...previous, ...files])].sort(), diagnostics };
  }

  /**
   * Remembers a finished reload for the dashboard, keeping the most recent 50.
   *
   * @param record - The reload, without its time.
   */
  private remember(record: Omit<ReloadRecord, "at">): void {
    this.reloads.push({ at: new Date().toISOString(), ...record });
    if (this.reloads.length > 50)
      this.reloads.shift();
  }

  /**
   * Starts a generation and, once it is prepared, swaps it in for the serving one.
   *
   * @param generation - The new generation's number.
   * @param build - What it loads.
   * @param started - When the rebuild began, for its duration.
   * @param files - The changed files, for the reload history.
   * @param plan - Why the process restarts.
   * @param revalidateQueues - Queues whose waiting messages are checked against their changed contract.
   */
  private async replace(generation: number, build: Build, started: number, files: readonly string[] = [], plan?: ReloadPlan, revalidateQueues: readonly string[] = []): Promise<void> {
    const { location } = this.options;
    const url = new URL(this.server!.url.href);
    const spawn = this.options.spawn ?? GenerationProcess.spawn;
    const next = spawn({
      request: { mode: "serve", root: location.root, buildDir: location.buildDir, stateDir: location.stateDir, publicOrigin: url.origin, generation, ...revalidateQueues.length === 0 ? {} : { revalidateQueues }, ...this.options.bindingsModule === undefined ? {} : { bindingsModule: this.options.bindingsModule } },
      ...this.options.env === undefined ? {} : { env: this.options.env },
      onLog: entry => this.emit({ type: "log", generation, entry }),
      onOutput: (stream, line) => this.emit({ type: "output", generation, stream, line })
    });
    this.starting = next;
    this.started += 1;
    this.alive += 1;
    void next.exited.then(() => {
      this.alive -= 1;
    });
    try {
      const prepared = await next.prepared(this.timeout("prepareMs", 30_000));
      if (!prepared.ok || this.stopping !== undefined) {
        await next.kill();
        if (!prepared.ok) {
          const failure = [this.reloadFailed(`Generation ${generation} could not start.`), ...this.located(prepared.diagnostics)];
          this.markStale(files, failure);
          this.fail("generation.failed", generation, failure);
          this.remember({ files, outcome: "failed", ...plan === undefined ? {} : { plan }, generation, durationMs: Math.round(performance.now() - started), diagnostics: failure });
        }
        return;
      }
      const previous = this.current;
      this.current = undefined;
      if (previous !== undefined) {
        const exitCode = await previous.process.stop(this.timeout("stopMs", 10_000));
        this.emit({ type: "generation.stopped", generation: previous.generation, exitCode });
      }
      const ready = await next.activate(this.timeout("activateMs", 30_000));
      if (!ready.ok) {
        await next.kill();
        this.fail("generation.failed", generation, [this.reloadFailed(`Generation ${generation} failed while starting.`), ...this.located(ready.diagnostics)]);
        return;
      }
      if (this.stopping !== undefined) {
        await next.stop(this.timeout("stopMs", 10_000));
        return;
      }
      this.current = { generation, process: next, port: ready.value, build, swaps: 0, versions: [] };
      this.failure = undefined;
      this.staleState = undefined;
      this.remember({ files, outcome: "restarted", ...plan === undefined ? {} : { plan }, generation, durationMs: Math.round(performance.now() - started), diagnostics: [] });
      void next.exited.then((exitCode) => {
        if (this.current?.process !== next || this.stopping !== undefined)
          return;
        this.current = undefined;
        this.failure = [createDiagnostic({ code: diagnosticCodes.localOperationFailed, severity: "error", message: `Generation ${generation} exited with code ${String(exitCode)}.`, hint: "Save a file to restart the application." })];
        this.emit({ type: "generation.exited", generation, exitCode });
      });
      this.release();
      this.emit({ type: "generation.ready", generation, pid: next.pid, durationMs: Math.round(performance.now() - started), summary: summarize(build.manifest, build.entrypoints, Date.now()) });
    } finally {
      this.starting = undefined;
    }
  }

  /**
   * Reports a failed rebuild. Without a serving generation, requests receive the failure.
   *
   * @param type - The event type.
   * @param generation - The generation that failed to start, if any.
   * @param diagnostics - Why.
   */
  private fail(type: "build.failed" | "generation.failed", generation: number | undefined, diagnostics: readonly Diagnostic[]): void {
    if (this.current === undefined) {
      this.failure = diagnostics;
      this.release();
    }
    const serving = this.serving();
    const stale = serving.serving === undefined ? {} : { stale: true };
    if (type === "build.failed")
      this.emit({ type, diagnostics, ...serving, ...stale });
    else
      this.emit({ type, generation: generation!, diagnostics, ...serving, ...stale });
  }

  /**
   * Describes which generation keeps serving.
   *
   * @returns `{ serving }`, or nothing when none serves.
   */
  private serving(): { readonly serving?: number } {
    return this.current === undefined ? {} : { serving: this.current.generation };
  }

  /**
   * Builds the summary diagnostic of a failed reload.
   *
   * @param message - What failed.
   * @returns A `HOLQA_RELOAD_FAILED` error.
   */
  private reloadFailed(message: string): Diagnostic {
    return createDiagnostic({
      code: diagnosticCodes.reloadFailed,
      severity: "error",
      message: this.current === undefined ? `${message} No generation is running.` : `${message} Generation ${this.current.generation} keeps serving.`,
      hint: "Fix the problems below and save; holqa dev rebuilds on the next change."
    });
  }

  /**
   * Rewrites diagnostic locations, which are relative to the application root, for display.
   *
   * @param diagnostics - Diagnostics whose locations are relative to the application root.
   * @returns The diagnostics with locations relative to the working directory.
   */
  private located(diagnostics: readonly Diagnostic[]): Diagnostic[] {
    return diagnostics.map(diagnostic => diagnostic.location === undefined
      ? diagnostic
      : createDiagnostic({ ...diagnostic, location: { ...diagnostic.location, file: this.path(join(this.options.location.root, diagnostic.location.file)) } }));
  }

  /**
   * Formats a path for display.
   *
   * @param path - An absolute path.
   * @returns The path relative to the working directory when inside it.
   */
  private path(path: string): string {
    return displayPath(this.options.cwd, path);
  }

  /**
   * Reads a time limit.
   *
   * @param name - Which one.
   * @param fallback - Its default.
   * @returns The limit in milliseconds.
   */
  private timeout(name: keyof SupervisorTimeouts, fallback: number): number {
    return this.options.timeouts?.[name] ?? fallback;
  }

  /**
   * Emits an event.
   *
   * @param event - The event to report.
   */
  private emit(event: DevEvent): void {
    if (event.type === "log") {
      this.recentLogs.push(event.entry);
      if (this.recentLogs.length > 500)
        this.recentLogs.shift();
    }
    this.options.onEvent(event);
  }

  /**
   * Reports whether the dashboard is served: enabled, and the session listens on a loopback address.
   *
   * @returns `true` when it is served.
   */
  private dashboardEnabled(): boolean {
    return (this.options.dashboard ?? true) && isLoopbackHost(this.options.hostname);
  }

  /**
   * Builds the dashboard's view of the session.
   *
   * @returns The sources the dashboard presents.
   */
  private dashboardSource(): DashboardSource {
    const { stateDir } = this.options.location;
    /**
     * Reads the local telemetry store, which may not exist yet.
     *
     * @param read - What to read from it.
     * @returns The value, or `undefined` without a store.
     */
    function withReader<Value>(read: (reader: NonNullable<ReturnType<typeof openLocalTelemetryReader>>) => Value): Value | undefined {
      const reader = openLocalTelemetryReader(stateDir);
      if (reader === undefined)
        return undefined;
      try {
        return read(reader);
      } finally {
        reader.close();
      }
    }
    return {
      status: () => JSON.parse(JSON.stringify(this.status())) as JsonObject,
      state: async () => {
        const current = this.current;
        if (current === undefined)
          return undefined;
        const response = await current.process.operate({ kind: "state" }, this.timeout("operationMs", 120_000));
        return response.ok ? response.result : undefined;
      },
      logs: () => this.recentLogs,
      traces: () => (withReader(reader => reader.traces(50)) ?? []) as unknown as JsonValue,
      trace: (traceId) => {
        const spans = withReader(reader => reader.trace(traceId));
        return spans === undefined || spans.length === 0 ? undefined : spans as unknown as JsonValue;
      }
    };
  }

  /** Releases everyone waiting for a generation. */
  private release(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const resolve of waiters)
      resolve();
  }

  /**
   * Waits for a serving generation while one is being started.
   *
   * @returns The serving generation, or `undefined` when none serves (failed, or still starting after the wait).
   */
  private async generation(): Promise<Current | undefined> {
    if (this.current !== undefined || (this.failure !== undefined && this.loop === undefined) || this.stopping !== undefined)
      return this.current;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await new Promise<void>((resolve) => {
      this.waiters.push(resolve);
      timer = setTimeout(resolve, this.timeout("requestWaitMs", 15_000));
    });
    clearTimeout(timer);
    return this.current;
  }

  /**
   * Serves one request of the session's address: the control endpoint, or a
   * request for the application, forwarded to the serving generation.
   *
   * @param request - The incoming request.
   * @returns The response.
   */
  private async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === operationsPath)
      return this.control(request);
    if (url.pathname === dashboardPath || url.pathname.startsWith(`${dashboardPath}/`)) {
      if (!this.dashboardEnabled())
        return new Response("The holqa dev dashboard is disabled for this session.", { status: 404 });
      return serveDashboard(request, this.dashboardSource());
    }
    const current = await this.generation();
    if (current === undefined) {
      const failure = this.failure?.[0];
      return Response.json({ error: { code: failure?.code ?? diagnosticCodes.runtimeNotRunning, message: failure === undefined ? "The application is not running." : "The application is not running because the last reload failed; see the holqa dev output." } }, { status: 503, headers: { "retry-after": "1" } });
    }
    try {
      return await fetch(`http://127.0.0.1:${current.port}${url.pathname}${url.search}`, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        redirect: "manual",
        decompress: false,
        signal: request.signal
      } as RequestInit);
    } catch {
      // The generation stopped while the request was in flight.
      return Response.json({ error: { code: diagnosticCodes.runtimeNotRunning, message: "The application restarted while the request was in flight; retry it." } }, { status: 503, headers: { "retry-after": "1" } });
    }
  }

  /**
   * Serves the control endpoint: authenticated local operations, forwarded to the serving generation.
   *
   * @param request - The incoming request.
   * @returns The operation response as JSON.
   */
  private async control(request: Request): Promise<Response> {
    if (request.method !== "POST")
      return new Response(null, { status: 405, headers: { allow: "POST" } });
    const presented = Buffer.from(request.headers.get("authorization") ?? "");
    const expected = Buffer.from(`Bearer ${this.token}`);
    if (presented.length !== expected.length || !timingSafeEqual(presented, expected))
      return new Response(null, { status: 401 });
    const body: unknown = await request.json().catch(() => undefined);
    const operation = readOperation(typeof body === "object" && body !== null ? (body as { readonly operation?: unknown }).operation : undefined);
    if (operation === undefined)
      return Response.json({ ok: false, diagnostics: [createDiagnostic({ code: diagnosticCodes.cliArgumentInvalid, severity: "error", message: "The operation is malformed." })] }, { status: 400 });
    const current = await this.generation();
    const response: OperationResponse = current === undefined
      ? { ok: false, diagnostics: this.failure ?? [createDiagnostic({ code: diagnosticCodes.runtimeNotRunning, severity: "error", message: "The dev session has no running generation." })] }
      : await current.process.operate(operation, this.timeout("operationMs", 120_000));
    return Response.json(response);
  }
}

/**
 * Builds a failed phase result.
 *
 * @param diagnostic - Why.
 * @returns The failure.
 */
function failed(diagnostic: Diagnostic): PhaseResult<string> {
  return { ok: false, diagnostics: [diagnostic] };
}