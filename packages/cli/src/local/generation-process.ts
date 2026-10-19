import type {
  Diagnostic,
  JsonObject
} from "@holqa/core";
import type { Subprocess } from "bun";

import type {
  ControlMessage,
  GenerationMessage,
  GenerationRequest,
  LocalOperation,
  OperationResponse
} from "@/local/protocol";
import { fileURLToPath } from "node:url";

import {
  createDiagnostic,
  diagnosticCodes
} from "@holqa/core";

import { readGenerationMessage } from "@/local/protocol";

/** Settings of {@link GenerationProcess.spawn}. */
export interface GenerationProcessOptions {
  readonly request: GenerationRequest;
  /** The environment of the application. Defaults to `process.env`: the application runs like any server the developer starts. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Receives every structured log entry. */
  readonly onLog?: (entry: JsonObject) => void;
  /** Receives what the application prints, line by line. */
  readonly onOutput?: (stream: "stdout" | "stderr", line: string) => void;
  /** The generation entry point; defaults to the one shipped next to this module. */
  readonly entryPath?: string;
  /** The Bun executable; defaults to the running one. */
  readonly bunPath?: string;
}

/** What a phase of the process resolves to: success, or the diagnostics of its failure. */
export type PhaseResult<Value> = { readonly ok: true; readonly value: Value } | { readonly ok: false; readonly diagnostics: readonly Diagnostic[] };

/** The phases a caller can wait for. */
type Phase = "prepared" | "ready" | "waiting";

/**
 * One generation process, seen from the CLI. Every promise it returns
 * settles: when the process fails or exits early, waiting callers receive a
 * failure instead of hanging.
 */
export class GenerationProcess {
  /** The spawned Bun process. */
  private readonly child: Subprocess<"ignore", "pipe", "pipe">;
  /** Settings. */
  private readonly options: GenerationProcessOptions;
  /** Waiters for each phase. */
  private readonly phases = new Map<Phase, Array<(result: PhaseResult<number>) => void>>();
  /** Phases already reached, with their value (the port, for `ready`). */
  private readonly reached = new Map<Phase, number>();
  /** Pending operation responses by request identifier. */
  private readonly pending = new Map<string, (response: OperationResponse) => void>();
  /** The diagnostics of a reported failure. */
  private failure: readonly Diagnostic[] | undefined;
  /** Operation request identifiers. */
  private sequence = 0;
  /** Resolves with the exit code once the process has exited. */
  readonly exited: Promise<number | null>;

  /**
   * Starts a generation process.
   *
   * @param options - The request, environment and output callbacks.
   * @returns The process, starting up.
   */
  static spawn(options: GenerationProcessOptions): GenerationProcess {
    return new GenerationProcess(options);
  }

  /**
   * Spawns the process; use {@link GenerationProcess.spawn}.
   *
   * @param options - The request, environment and output callbacks.
   */
  private constructor(options: GenerationProcessOptions) {
    this.options = options;
    this.child = Bun.spawn({
      cmd: [options.bunPath ?? process.execPath, "--no-install", options.entryPath ?? defaultEntryPath(), JSON.stringify(options.request)],
      cwd: options.request.root,
      env: { ...(options.env ?? process.env) },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      ipc: received => this.receive(received)
    });
    void this.pipe(this.child.stdout, "stdout");
    void this.pipe(this.child.stderr, "stderr");
    this.exited = this.child.exited.then((code) => {
      const diagnostics = this.failure ?? [createDiagnostic({ code: diagnosticCodes.localOperationFailed, severity: "error", message: `The application process exited with code ${String(code)}.`, hint: "See the application's output above; a module may have called process.exit() or crashed." })];
      for (const [phase, waiters] of this.phases) {
        if (!this.reached.has(phase)) {
          for (const resolve of waiters)
            resolve({ ok: false, diagnostics });
        }
      }
      this.phases.clear();
      for (const resolve of this.pending.values())
        resolve({ ok: false, diagnostics });
      this.pending.clear();
      return code;
    });
  }

  /** The process identifier. */
  get pid(): number {
    return this.child.pid;
  }

  /**
   * Waits until the process loaded the application and checked that it can
   * start (`serve` mode), without consuming or serving anything yet.
   *
   * @param timeoutMs - How long to wait.
   * @returns Success, or the diagnostics that prevent the generation from starting.
   */
  async prepared(timeoutMs: number): Promise<PhaseResult<undefined>> {
    const result = await this.phase("prepared", timeoutMs);
    return result.ok ? { ok: true, value: undefined } : result;
  }

  /**
   * Tells a prepared process to start consuming and serving, and waits until it listens.
   *
   * @param timeoutMs - How long to wait.
   * @returns The port the process listens on, or the diagnostics of its failure.
   */
  async activate(timeoutMs: number): Promise<PhaseResult<number>> {
    this.post({ type: "activate" });
    return this.phase("ready", timeoutMs);
  }

  /**
   * Runs one operation. In `once` mode the process exits after it.
   *
   * @param operation - The operation to run.
   * @param timeoutMs - How long to wait for the response.
   * @returns The response; a failure when the process exits or does not answer in time.
   */
  async operate(operation: LocalOperation, timeoutMs: number): Promise<OperationResponse> {
    if (this.options.request.mode === "once") {
      const waiting = await this.phase("waiting", timeoutMs);
      if (!waiting.ok)
        return waiting;
    }
    const id = String(++this.sequence);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const response = new Promise<OperationResponse>((resolve) => {
      this.pending.set(id, resolve);
      timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, diagnostics: [createDiagnostic({ code: diagnosticCodes.localOperationFailed, severity: "error", message: `The application did not answer within ${timeoutMs} ms.` })] });
      }, timeoutMs);
    });
    this.post({ type: "operation", id, operation });
    try {
      return await response;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Stops the process gracefully: in-flight invocations get a grace period
   * and deliveries are settled. A process that does not exit in time is killed.
   *
   * @param timeoutMs - How long to wait before killing it.
   * @returns The exit code.
   */
  async stop(timeoutMs: number): Promise<number | null> {
    this.post({ type: "stop" });
    const timer = setTimeout(() => this.child.kill("SIGKILL"), timeoutMs);
    try {
      return await this.exited;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Kills the process at once.
   *
   * @returns The exit code.
   */
  async kill(): Promise<number | null> {
    this.child.kill("SIGKILL");
    return this.exited;
  }

  /**
   * Sends a control message, ignoring a process that already exited.
   *
   * @param message - The control message to send.
   */
  private post(message: ControlMessage): void {
    try {
      this.child.send(JSON.stringify(message));
    } catch {
      // The process has exited; `exited` reports that to every waiter.
    }
  }

  /**
   * Waits for a phase.
   *
   * @param phase - The phase to wait for.
   * @param timeoutMs - How long to wait.
   * @returns The phase's value, or a failure.
   */
  private async phase(phase: Phase, timeoutMs: number): Promise<PhaseResult<number>> {
    if (this.reached.has(phase))
      return { ok: true, value: this.reached.get(phase)! };
    if (this.failure !== undefined)
      return { ok: false, diagnostics: this.failure };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const result = new Promise<PhaseResult<number>>((resolve) => {
      const waiters = this.phases.get(phase) ?? [];
      waiters.push(resolve);
      this.phases.set(phase, waiters);
      timer = setTimeout(() => resolve({ ok: false, diagnostics: [createDiagnostic({ code: diagnosticCodes.localOperationFailed, severity: "error", message: `The application process did not become ${phase} within ${timeoutMs} ms.`, hint: "Module evaluation and startup must not wait for network, timers or input." })] }), timeoutMs);
    });
    try {
      return await result;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Handles one message from the process.
   *
   * @param raw - The received value.
   */
  private receive(raw: unknown): void {
    const message: GenerationMessage | undefined = readGenerationMessage(raw);
    if (message === undefined)
      return;
    switch (message.type) {
      case "prepared":
      case "waiting":
        this.reach(message.type, 0);
        break;
      case "ready":
        this.reach("ready", message.port);
        break;
      case "log":
        this.options.onLog?.(message.entry);
        break;
      case "result": {
        const resolve = this.pending.get(message.id);
        this.pending.delete(message.id);
        resolve?.(message.response);
        break;
      }
      case "failed":
        this.failure = message.diagnostics;
        for (const waiters of this.phases.values()) {
          for (const resolve of waiters)
            resolve({ ok: false, diagnostics: message.diagnostics });
        }
        this.phases.clear();
        break;
      case "stopped":
        break;
    }
  }

  /**
   * Records a reached phase and releases its waiters.
   *
   * @param phase - The phase that was reached.
   * @param value - Its value.
   */
  private reach(phase: Phase, value: number): void {
    this.reached.set(phase, value);
    for (const resolve of this.phases.get(phase) ?? [])
      resolve({ ok: true, value });
    this.phases.delete(phase);
  }

  /**
   * Forwards a stream of the process line by line.
   *
   * @param stream - The standard output or error pipe of the process.
   * @param name - Which stream it is.
   * @returns A promise that settles at the end of the stream.
   */
  private async pipe(stream: ReadableStream<Uint8Array>, name: "stdout" | "stderr"): Promise<void> {
    const decoder = new TextDecoder();
    let buffered = "";
    try {
      for await (const chunk of stream) {
        buffered += decoder.decode(chunk, { stream: true });
        const lines = buffered.split("\n");
        buffered = lines.pop() ?? "";
        for (const line of lines)
          this.options.onOutput?.(name, line);
      }
    } catch {
      // The pipe closes when the process is killed; there is nothing left to forward.
    }
    if (buffered !== "")
      this.options.onOutput?.(name, buffered);
  }
}

/**
 * Locates the generation entry point: `generation.js` next to the built CLI,
 * or `generation-entry.ts` next to this module when running from source.
 *
 * @returns The absolute path of the entry point.
 */
export function defaultEntryPath(): string {
  const fromSource = import.meta.url.endsWith(".ts");
  return fileURLToPath(new URL(fromSource ? "./generation-entry.ts" : "./generation.js", import.meta.url));
}