// Entry point of a generation process: one evaluated copy of the application,
// with its own runtime and a local environment on the shared state directory.
// `holqa dev` starts one per reload; the operation commands start one in
// `once` mode when no dev session is running. The CLI sends the request as the
// first argument and talks to the process over IPC with JSON texts.
import type { Diagnostic } from "@holqa/core";
import type { LocalEnvironment } from "@holqa/local";
import type {
  CompiledApplication,
  LogSink,
  Runtime
} from "@holqa/runtime-bun";

import type { SwapRequest } from "@/local/hot-swap";
import type { OperationContext } from "@/local/operations";
import type {
  ControlMessage,
  GenerationMessage,
  GenerationRequest,
  LocalOperation,
  OperationResponse
} from "@/local/protocol";
import type { ProcessTelemetry } from "@/local/telemetry";
import {
  mkdtempSync,
  rmSync
} from "node:fs";
import { tmpdir } from "node:os";
import {
  dirname,
  join
} from "node:path";

import {
  checkCapabilities,
  checkTriggerDelivery,
  createDiagnostic,
  diagnosticCodes,
  getAppDescriptor,
  getHandlerDescriptor,
  HolqaError,
  validateInput
} from "@holqa/core";
import { createLocalEnvironment } from "@holqa/local";
import {
  createRuntime,
  loadCompiledApplication
} from "@holqa/runtime-bun";

import { HotSwapper } from "@/local/hot-swap";
import {
  executeOperation,
  LogCapture,
  operationDiagnostics
} from "@/local/operations";
import {
  readControlMessage,
  toJson
} from "@/local/protocol";
import { openProcessTelemetry } from "@/local/telemetry";

/** The largest request body a generation accepts; signed uploads to the local storage can be this large. */
const maxRequestBodySize = 100 * 1024 * 1024;

/**
 * Sends one message to the CLI.
 *
 * @param message - The message to send.
 */
function send(message: GenerationMessage): void {
  process.send?.(JSON.stringify(message));
}

/** Control messages that arrived before anyone waited for them. */
const inbox: ControlMessage[] = [];

/** Whoever waits for the next control message. */
let waiter: ((message: ControlMessage) => void) | undefined;

/** Handles operations while serving; set once the generation is ready. */
let onOperation: ((id: string, operation: LocalOperation) => void) | undefined;

/** Handles handler replacements while serving; set once the generation is ready. */
let onSwap: ((id: string, swap: SwapRequest) => void) | undefined;

/**
 * Stops the generation; replaced once there is something to stop.
 *
 * @returns A promise that settles once the process is exiting.
 */
let shutdown: () => Promise<void> = async () => process.exit(0);

process.on("message", (raw: unknown) => {
  const message = readControlMessage(raw);
  if (message === undefined)
    return;
  if (message.type === "operation" && onOperation !== undefined) {
    onOperation(message.id, message.operation);
    return;
  }
  if (message.type === "swap" && onSwap !== undefined) {
    onSwap(message.id, message.swap);
    return;
  }
  if (message.type === "stop" && waiter === undefined) {
    void shutdown();
    return;
  }
  if (waiter !== undefined) {
    const resolve = waiter;
    waiter = undefined;
    resolve(message);
  } else {
    inbox.push(message);
  }
});

// The CLI may die without stopping its generation; never outlive it.
process.on("disconnect", () => void shutdown());
const parent = process.ppid;
setInterval(() => {
  if (process.ppid !== parent)
    void shutdown();
}, 1_000).unref();

/**
 * Waits for the next control message.
 *
 * @returns The message.
 */
async function next(): Promise<ControlMessage> {
  const queued = inbox.shift();
  if (queued !== undefined)
    return queued;
  return new Promise((resolve) => {
    waiter = resolve;
  });
}

/**
 * Reads and checks the request.
 *
 * @param argument - The JSON-encoded request.
 * @returns The checked request.
 * @throws {Error} When the request is malformed; the CLI always sends a valid one.
 */
function readRequest(argument: string | undefined): GenerationRequest {
  const request = JSON.parse(argument ?? "{}") as Partial<GenerationRequest>;
  if ((request.mode !== "serve" && request.mode !== "once") || typeof request.root !== "string" || typeof request.buildDir !== "string" || typeof request.stateDir !== "string" || typeof request.publicOrigin !== "string" || typeof request.generation !== "number")
    throw new Error("The generation process needs a request with mode, root, buildDir, stateDir, publicOrigin and generation.");
  if (request.revalidateQueues !== undefined && !(Array.isArray(request.revalidateQueues) && request.revalidateQueues.every(queueId => typeof queueId === "string")))
    throw new Error("The generation request's revalidateQueues must be a list of queue identifiers.");
  return request as GenerationRequest;
}

/**
 * Checks, before anything is started, that the local binding can provide
 * every resource and deliver every handler's trigger, so a reload never
 * replaces a running generation with one that cannot start.
 *
 * @param compiled - The loaded application.
 * @param runtime - The created, not yet started runtime.
 * @param local - The local environment.
 * @throws {HolqaError} `HOLQA_BINDING_CAPABILITY_UNSUPPORTED`, one per problem.
 */
function precheck(compiled: CompiledApplication, runtime: Runtime, local: LocalEnvironment): void {
  const descriptor = getAppDescriptor(compiled.app)!;
  const problems: Diagnostic[] = [
    ...descriptor.resources.flatMap(resource => checkCapabilities(resource, local.binding.capabilities, local.binding.name)),
    ...checkTriggerDelivery(descriptor, runtime.handlers, local.binding)
  ];
  if (problems.length > 0)
    throw new HolqaError(problems);
}

/**
 * Serves the application for `holqa dev`: prepares everything that can fail,
 * reports `prepared`, starts consuming and serving only when activated (the
 * previous generation has stopped by then), and runs operations until stopped.
 *
 * @param request - The generation request.
 */
async function serve(request: GenerationRequest): Promise<void> {
  const logs = new LogCapture();
  let telemetry: ProcessTelemetry | undefined;
  /**
   * Records an entry for operations and the telemetry store, and forwards it to the CLI.
   *
   * @param entry - A runtime log entry.
   */
  const sink: LogSink = (entry) => {
    logs.add(entry);
    telemetry?.writeLog(entry);
    send({ type: "log", entry: { ...entry, generation: request.generation } });
  };
  let local: LocalEnvironment | undefined;
  let runtime: Runtime;
  let compiled: CompiledApplication;
  try {
    compiled = await loadCompiledApplication({ root: request.root, buildDir: request.buildDir });
    local = await createLocalEnvironment({ app: compiled.app, directory: request.stateDir, root: request.root, storage: { signedUrlBase: `${request.publicOrigin}/_holqa/storage` } });
    telemetry = openProcessTelemetry(request.stateDir, process.env);
    runtime = createRuntime({ ...compiled, binding: local.binding, log: sink, telemetry: telemetry.options });
    precheck(compiled, runtime, local);
    await revalidateQueues(compiled, local, request.revalidateQueues ?? [], sink);
  } catch (error) {
    telemetry?.store.close();
    local?.close();
    send({ type: "failed", diagnostics: operationDiagnostics(error) });
    process.exit(1);
  }
  const environment = local;
  const store = telemetry.store;
  shutdown = async () => {
    store.close();
    environment.close();
    process.exit(0);
  };
  send({ type: "prepared" });
  const command = await next();
  if (command.type !== "activate") {
    await shutdown();
    return;
  }

  try {
    await runtime.start();
  } catch (error) {
    store.close();
    environment.close();
    send({ type: "failed", diagnostics: operationDiagnostics(error) });
    process.exit(1);
  }
  retireStaleSubscriptions(compiled, runtime, environment, sink);
  const origin = new URL(request.publicOrigin);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    maxRequestBodySize,
    fetch: (incoming) => {
      // The dev server forwards requests here; restore the address the client used, so handlers see it.
      const url = new URL(incoming.url);
      url.protocol = origin.protocol;
      url.host = origin.host;
      const headers = new Headers(incoming.headers);
      headers.set("host", origin.host);
      const forwarded = new Request(url.href, { method: incoming.method, headers, body: incoming.body, signal: incoming.signal, redirect: "manual" });
      return environment.storage.handles(forwarded) ? environment.storage.fetch(forwarded) : runtime.fetch(forwarded);
    }
  });
  const swapper = new HotSwapper({
    root: request.root,
    outDir: join(dirname(request.buildDir), "hot", String(request.generation)),
    handlers: Object.entries(compiled.handlerSources).map(([id, source]) => {
      const separator = source.lastIndexOf("#");
      return { id, module: source.slice(0, separator), export: source.slice(separator + 1) };
    }),
    runtime
  });
  let swapping = Promise.resolve();
  onSwap = (id, swap) => {
    // One replacement at a time, in the order they were asked for.
    swapping = swapping.then(async () => send({ type: "swap-result", id, outcome: await swapper.swap(swap) }));
  };
  let stopping: Promise<void> | undefined;
  shutdown = () => {
    stopping ??= (async () => {
      onOperation = undefined;
      onSwap = undefined;
      try {
        await runtime.stop({ graceMs: 5_000, forceMs: 1_000 });
      } finally {
        await server.stop(true);
        store.close();
        environment.close();
        swapper.dispose();
        send({ type: "stopped" });
        process.exit(0);
      }
    })();
    return stopping;
  };
  const context: OperationContext = { app: compiled.app, descriptor: getAppDescriptor(compiled.app)!, local: environment, runtime, logs, createId: () => crypto.randomUUID(), now: () => Date.now() };
  onOperation = (id, operation) => {
    void respond(context, operation).then(response => send({ type: "result", id, response }));
  };
  send({ type: "ready", port: server.port ?? 0 });
  for (;;) {
    const message = await next();
    if (message.type === "stop") {
      await shutdown();
      return;
    }
  }
}

/**
 * Removes object event subscriptions of handlers that no longer exist, so
 * renaming or deleting a handler during development does not leave events
 * piling up for it. Logged as a warning when anything is removed.
 *
 * @param compiled - The loaded application.
 * @param runtime - The started runtime.
 * @param local - The local environment.
 * @param sink - Where the warning goes.
 */
function retireStaleSubscriptions(compiled: CompiledApplication, runtime: Runtime, local: LocalEnvironment, sink: LogSink): void {
  const descriptor = getAppDescriptor(compiled.app)!;
  for (const resource of descriptor.resources) {
    if (resource.kind !== "bucket")
      continue;
    const current = runtime.handlers.filter(handler => (handler.trigger.kind === "bucket.object-created" || handler.trigger.kind === "bucket.object-deleted") && handler.trigger.resource.id === resource.id).map(handler => handler.id);
    const removed = local.storage.retainSubscriptions(resource.id, current);
    if (removed.length > 0)
      sink({ level: "warn", time: new Date().toISOString(), message: "removed object event subscriptions of handlers that no longer exist", application: descriptor.name, resourceId: resource.id, subscriptions: removed });
  }
}

/**
 * Checks the messages waiting in queues whose message contract changed
 * against the new contract, and logs a `HOLQA_QUEUED_MESSAGE_INCOMPATIBLE`
 * warning per queue with messages the new consumer would reject. Messages are
 * never changed or removed: during development they can be redriven,
 * replaced or left to fail.
 *
 * @param compiled - The loaded application.
 * @param local - The local environment.
 * @param queueIds - The queues whose contract changed.
 * @param sink - Where the warnings go.
 */
async function revalidateQueues(compiled: CompiledApplication, local: LocalEnvironment, queueIds: readonly string[], sink: LogSink): Promise<void> {
  const descriptor = getAppDescriptor(compiled.app)!;
  for (const queueId of queueIds) {
    const queue = descriptor.resources.find(resource => resource.kind === "queue" && resource.id === queueId);
    if (queue === undefined || queue.kind !== "queue")
      continue;
    const waiting = local.queues.messages(queue.id, ["ready", "delayed", "in-flight"]);
    const rejected: string[] = [];
    const otherVersion: string[] = [];
    let firstProblem: string | undefined;
    for (const message of waiting) {
      if (message.schemaVersion !== queue.config.schemaVersion) {
        otherVersion.push(message.messageId);
        continue;
      }
      try {
        await validateInput(queue.schemas.message, message.payload, `message for queue "${queue.id}"`);
      } catch (error) {
        rejected.push(message.messageId);
        firstProblem ??= error instanceof Error ? error.message : String(error);
      }
    }
    if (rejected.length === 0 && otherVersion.length === 0)
      continue;
    sink({
      level: "warn",
      time: new Date().toISOString(),
      message: "messages waiting in a queue do not match its changed message contract",
      application: descriptor.name,
      code: diagnosticCodes.queuedMessageIncompatible,
      resourceId: queue.id,
      waiting: waiting.length,
      incompatible: rejected.length,
      otherSchemaVersion: otherVersion.length,
      messageIds: [...rejected, ...otherVersion].slice(0, 10),
      ...firstProblem === undefined ? {} : { problem: firstProblem }
    });
  }
}

/**
 * Runs one operation and describes its outcome.
 *
 * @param context - The operation context.
 * @param operation - The operation to run.
 * @returns The response.
 */
async function respond(context: OperationContext, operation: LocalOperation): Promise<OperationResponse> {
  try {
    return { ok: true, result: await executeOperation(context, operation) };
  } catch (error) {
    return { ok: false, diagnostics: operationDiagnostics(error) };
  }
}

/**
 * Runs one operation without a dev session: loads the application, creates
 * only the runtime the operation needs, runs it and exits. Invocations use
 * `manualTriggers`, so this process never consumes queues or events that a
 * dev session started later would expect to receive.
 *
 * @param request - The generation request.
 */
async function once(request: GenerationRequest): Promise<void> {
  send({ type: "waiting" });
  const message = await next();
  if (message.type !== "operation")
    process.exit(0);
  send({ type: "result", id: message.id, response: await runOnce(request, message.operation) });
}

/**
 * Prepares what one operation needs, runs it, and releases everything again.
 *
 * @param request - The generation request.
 * @param operation - The operation to run.
 * @returns The operation's response.
 */
async function runOnce(request: GenerationRequest, operation: LocalOperation): Promise<OperationResponse> {
  const logs = new LogCapture();
  let local: LocalEnvironment | undefined;
  let runtime: Runtime | undefined;
  let telemetry: ProcessTelemetry | undefined;
  /**
   * Records an entry for the operation and the telemetry store.
   *
   * @param entry - A runtime log entry.
   */
  const sink: LogSink = (entry) => {
    logs.add(entry);
    telemetry?.writeLog(entry);
  };
  // Doctor never touches the real state: it checks configuration and capabilities against a scratch directory.
  const scratch = operation.kind === "doctor" ? mkdtempSync(join(tmpdir(), "holqa-doctor-")) : undefined;
  try {
    const compiled = await loadCompiledApplication({ root: request.root, buildDir: request.buildDir });
    try {
      local = await createLocalEnvironment({ app: compiled.app, directory: scratch ?? request.stateDir, root: request.root, storage: { signedUrlBase: `${request.publicOrigin}/_holqa/storage` } });
    } catch (error) {
      if (operation.kind !== "doctor")
        throw error;
      return { ok: true, result: { checks: [{ name: "configuration", status: "error", message: "The configuration is invalid or incomplete.", diagnostics: toJson(operationDiagnostics(error)) }] } };
    }
    const environment = local;
    // Operations that run handlers record telemetry like the dev session does; doctor only checks.
    if (operation.kind === "invoke" || operation.kind === "cron.run")
      telemetry = openProcessTelemetry(request.stateDir, process.env);
    const telemetryOptions = telemetry === undefined ? {} : { telemetry: telemetry.options };
    if (operation.kind === "invoke" || operation.kind === "doctor") {
      runtime = createRuntime({ ...compiled, binding: environment.binding, manualTriggers: true, log: sink, ...telemetryOptions });
      if (operation.kind === "invoke")
        await runtime.start();
    } else if (operation.kind === "cron.run") {
      // Only the schedule's own handlers, receiving only schedules: queues and events wait for the next dev session.
      const handlers = compiled.handlers.filter((handler) => {
        const trigger = getHandlerDescriptor(handler)?.definition.trigger;
        return trigger?.kind === "schedule.tick" && trigger.resource.id === operation.scheduleId;
      });
      const schedules = environment.binding.sources?.schedule;
      runtime = createRuntime({ ...compiled, handlers, binding: { ...environment.binding, sources: schedules === undefined ? {} : { schedule: schedules } }, log: sink, ...telemetryOptions });
      await runtime.start();
    }
    return await respond({ app: compiled.app, descriptor: getAppDescriptor(compiled.app)!, local: environment, runtime, logs, createId: () => crypto.randomUUID(), now: () => Date.now() }, operation);
  } catch (error) {
    return { ok: false, diagnostics: operationDiagnostics(error) };
  } finally {
    await runtime?.stop({ graceMs: 5_000, forceMs: 1_000 });
    telemetry?.store.close();
    local?.close();
    if (scratch !== undefined)
      rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * Runs the generation process.
 *
 * @param argument - The JSON-encoded request.
 */
async function main(argument: string | undefined): Promise<void> {
  if (process.send === undefined)
    throw new Error("The generation process must be started with an IPC channel.");
  const request = readRequest(argument);
  if (request.mode === "serve") {
    await serve(request);
    return;
  }
  await once(request);
  // Let the result reach the CLI before exiting.
  setTimeout(() => process.exit(0), 50);
}

main(process.argv[2]).catch((error: unknown) => {
  send({ type: "failed", diagnostics: [createDiagnostic({ code: diagnosticCodes.localOperationFailed, severity: "error", message: `The application process failed: ${error instanceof Error ? error.message : String(error)}` })] });
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});