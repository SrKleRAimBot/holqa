import type {
  EntrypointMap,
  Manifest
} from "@holqa/compiler";
import type { Diagnostic } from "@holqa/core";
import type { Server } from "bun";

import type { AnalysisOutcome } from "@/analysis/host";
import type { ManifestChange } from "@/dev/classify";
import type { DevEvent } from "@/dev/events";
import type {
  GenerationProcessOptions,
  PhaseResult
} from "@/local/generation-process";
import type { AppLocation } from "@/local/locations";
import type { OperationResponse } from "@/local/protocol";
import {
  randomBytes,
  timingSafeEqual
} from "node:crypto";
import { join } from "node:path";

import {
  serializeEntrypoints,
  serializeManifest
} from "@holqa/compiler";
import {
  createDiagnostic,
  diagnosticCodes
} from "@holqa/core";

import { displayPath } from "@/commands/analysis-command";
import { classifyChange } from "@/dev/classify";
import { summarize } from "@/dev/events";
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
  /** Starts generation processes; replaceable in tests. */
  readonly spawn?: (options: GenerationProcessOptions) => GenerationProcess;
  readonly timeouts?: SupervisorTimeouts;
  /** Watch debounce period in milliseconds. Default 100. */
  readonly debounceMs?: number;
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
  readonly build: Build;
}

/** Counters of a session, for tests and diagnostics. */
export interface SupervisorStats {
  /** The generation serving requests, if any. */
  readonly serving: number | undefined;
  /** How many generation processes were started. */
  readonly started: number;
  /** How many generation processes are alive now. */
  readonly alive: number;
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
    return { serving: this.current?.generation, started: this.started, alive: this.alive };
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
    this.emit({ type: "dev.listening", url, stateDirectory: this.path(location.stateDir), buildDirectory: this.path(location.buildDir), watching: this.options.watch });
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
    if (build !== undefined && files.length > 0 && files.every(isEnvironmentFile)) {
      // Only `.env` files changed: the analysis never sees them, so only the application process restarts.
      change = { kind: "environment", resources: { added: [], removed: [], changed: [] }, handlers: { added: [], removed: [], changed: [] }, config: { added: [], removed: [], changed: [] }, contracts: [] };
    } else {
      const outcome = await this.options.analyze(this.options.location.appPath);
      for (const line of outcome.output.split("\n").filter(text => text !== ""))
        this.emit({ type: "output", generation: this.generations + 1, stream: "stderr", line });
      if (!outcome.ok) {
        this.fail("build.failed", undefined, [this.reloadFailed("The application no longer analyzes."), ...this.located(outcome.diagnostics)]);
        return;
      }
      const { manifest, entrypoints } = outcome;
      try {
        await this.options.writeFile(join(this.options.location.buildDir, "manifest.json"), `${serializeManifest(manifest)}\n`);
        await this.options.writeFile(join(this.options.location.buildDir, "entrypoints.json"), `${serializeEntrypoints(entrypoints)}\n`);
      } catch (error) {
        this.fail("build.failed", undefined, [createDiagnostic({ code: diagnosticCodes.buildOutputFailed, severity: "error", message: `Could not write the dev build to "${this.path(this.options.location.buildDir)}": ${error instanceof Error ? error.message : String(error)}` })]);
        return;
      }
      // Compare with what runs, not with a build that failed to start: queued messages were written under the running contracts.
      change = classifyChange(this.current?.build.manifest ?? this.built?.manifest, manifest);
      diagnostics = [...this.located(outcome.diagnostics), ...change.contracts];
      build = { manifest, entrypoints };
      this.built = build;
    }
    const generation = ++this.generations;
    this.emit({ type: "build", generation, change, fingerprint: build!.entrypoints.manifest, durationMs: Math.round(performance.now() - started), diagnostics });
    await this.replace(generation, build!, started);
  }

  /**
   * Starts a generation and, once it is prepared, swaps it in for the serving one.
   *
   * @param generation - The new generation's number.
   * @param build - What it loads.
   * @param started - When the rebuild began, for its duration.
   */
  private async replace(generation: number, build: Build, started: number): Promise<void> {
    const { location } = this.options;
    const url = new URL(this.server!.url.href);
    const spawn = this.options.spawn ?? GenerationProcess.spawn;
    const next = spawn({
      request: { mode: "serve", root: location.root, buildDir: location.buildDir, stateDir: location.stateDir, publicOrigin: url.origin, generation },
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
        if (!prepared.ok)
          this.fail("generation.failed", generation, [this.reloadFailed(`Generation ${generation} could not start.`), ...this.located(prepared.diagnostics)]);
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
      this.current = { generation, process: next, port: ready.value, build };
      this.failure = undefined;
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
    if (type === "build.failed")
      this.emit({ type, diagnostics, ...this.serving() });
    else
      this.emit({ type, generation: generation!, diagnostics, ...this.serving() });
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
    this.options.onEvent(event);
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