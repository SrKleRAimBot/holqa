import type { ValidatedHandler } from "@holqa/bindings";
import type { Diagnostic } from "@holqa/core";
import type {
  LogSink,
  Runtime,
  RuntimeLimits,
  RuntimeTelemetryOptions
} from "@holqa/runtime-bun";

import type { VerifiedArtifact } from "@/artifact";
import type { ContainerEnvironment } from "@/settings";

import {
  createBinding,
  createBindingManifest,
  inspectBindings,
  isBindingsDefinition,
  resolveBindings,
  validateBindings
} from "@holqa/bindings";
import {
  createDiagnostic,
  diagnosticCodes,
  diagnosticsOf,
  getAppDescriptor,
  HolqaError
} from "@holqa/core";
import {
  createRuntime,
  jsonLineSink,
  serve,
  stopOnSignals
} from "@holqa/runtime-bun";

import { verifyArtifact } from "@/artifact";
import { readContainerSettings } from "@/settings";

/** The paths of the probe endpoints a container answers before routing. */
export const probePaths = Object.freeze({ livePath: "/.holqa/live", readyPath: "/.holqa/ready" });

/** What a container runs. */
export interface ContainerOptions {
  /** The application: the default export of its `infra.ts`. */
  readonly app: unknown;
  /** Every handler registration, in manifest order. */
  readonly handlers: readonly unknown[];
  /** The binding configuration: the default export of a bindings module. */
  readonly bindings: unknown;
  /**
   * The artifact directory written by `holqa package`. When given, the
   * artifact is verified before anything starts, and the binding resolved at
   * start must equal the packaged binding manifest. Absent when running from
   * source, which skips both checks.
   */
  readonly directory?: string;
  /** The environment settings and the default configuration source read. Default `process.env`. */
  readonly env?: ContainerEnvironment;
  /** Where logs go. Default JSON lines on standard output. */
  readonly log?: LogSink;
  /** The runtime's limits; checked against the execution host's. */
  readonly limits?: RuntimeLimits;
  readonly telemetry?: RuntimeTelemetryOptions;
  /** Whether `SIGTERM` and `SIGINT` drain and exit the process. Default `true`. */
  readonly signals?: boolean;
}

/** A started container. */
export interface RunningContainer {
  /** Where the server listens. */
  readonly url: URL;
  readonly port: number;
  readonly runtime: Runtime;
  /** Drains in-flight work within the configured grace periods and closes everything. Idempotent. */
  readonly stop: () => Promise<void>;
}

/**
 * Lists the top-level fields in which two JSON values differ.
 *
 * @param packaged - The packaged binding manifest.
 * @param current - The binding manifest resolved now.
 * @returns The differing field names, sorted.
 */
function differingFields(packaged: unknown, current: unknown): string[] {
  const left = (typeof packaged === "object" && packaged !== null ? packaged : {}) as Readonly<Record<string, unknown>>;
  const right = current as Readonly<Record<string, unknown>>;
  return [...new Set([...Object.keys(left), ...Object.keys(right)])].filter(key => !sameJson(left[key], right[key])).sort();
}

/**
 * Compares two JSON values structurally, ignoring key order.
 *
 * @param left - One value.
 * @param right - The other value.
 * @returns `true` when they are the same JSON data.
 */
function sameJson(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) || Array.isArray(right))
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((item, index) => sameJson(item, right[index]));
  if (typeof left === "object" && left !== null && typeof right === "object" && right !== null) {
    const keys = Object.keys(left);
    return keys.length === Object.keys(right).length && keys.every(key => Object.hasOwn(right, key) && sameJson((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]));
  }
  return left === right;
}

/**
 * Builds an `HOLQA_ARTIFACT_INVALID` diagnostic for a mismatch between the artifact and the code or configuration that runs.
 *
 * @param message - What differs.
 * @param hint - How to fix it.
 * @param details - Machine-readable details.
 * @returns The diagnostic.
 */
function mismatch(message: string, hint: string, details: Readonly<Record<string, string | readonly string[]>>): Diagnostic {
  return createDiagnostic({ code: diagnosticCodes.artifactInvalid, severity: "error", message, hint, details });
}

/**
 * Reads the handlers of a verified application manifest, for the same
 * binding checks packaging ran.
 *
 * @param artifact - The verified artifact.
 * @returns The manifest's application name and handlers.
 * @throws {HolqaError} `HOLQA_ARTIFACT_INVALID` when the manifest lacks them.
 */
function manifestParts(artifact: VerifiedArtifact): { readonly name: string; readonly handlers: readonly ValidatedHandler[] } {
  const manifest = artifact.manifest as { readonly application?: { readonly name?: unknown }; readonly handlers?: unknown };
  const name = manifest.application?.name;
  if (typeof name !== "string" || !Array.isArray(manifest.handlers))
    throw new HolqaError(mismatch("The artifact's manifest.json is not an application manifest.", "Package the application again with holqa package.", { file: "manifest.json" }));
  return { name, handlers: manifest.handlers as ValidatedHandler[] };
}

/**
 * Starts an application the way a conventional Bun container runs it:
 *
 * 1. reads settings from the environment (`PORT`, `HOST`, shutdown periods);
 * 2. verifies the artifact, when `directory` is given: every file's hash,
 *    the manifests and the Bun version;
 * 3. resolves the binding configuration and refuses any error, then checks
 *    that the binding equals the packaged binding manifest (a provider
 *    setting that changed since packaging is a mismatch, never silently used);
 * 4. composes the binding and creates the runtime, validating every handler's
 *    delivery against the selected providers and the host's limits;
 * 5. starts the runtime (which opens and readies every provider and starts
 *    background deliveries) and serves HTTP with probes on
 *    {@link probePaths}: liveness answers while the process serves,
 *    readiness only while the runtime runs and no component is unhealthy;
 * 6. on `SIGTERM` or `SIGINT`, answers new requests with `503`, drains
 *    in-flight work within the grace period, stops providers and exits.
 *
 * @param options - The application, handlers, binding configuration and artifact.
 * @returns The running container.
 * @throws {HolqaError} `HOLQA_CONTAINER_SETTINGS_INVALID`, `HOLQA_ARTIFACT_INVALID`, the binding configuration's diagnostics, or `HOLQA_RUNTIME_START_FAILED`.
 */
export async function startContainer(options: ContainerOptions): Promise<RunningContainer> {
  const env = options.env ?? process.env;
  const settings = readContainerSettings(env);
  const artifact = options.directory === undefined ? undefined : await verifyArtifact(options.directory, Bun.version);
  const descriptor = getAppDescriptor(options.app);
  if (descriptor === undefined)
    throw new HolqaError(createDiagnostic({ code: diagnosticCodes.appInvalid, severity: "error", message: "The container's application is not a Holqa application." }));
  if (!isBindingsDefinition(options.bindings) || options.bindings.app !== descriptor)
    throw new HolqaError(createDiagnostic({ code: diagnosticCodes.bindingConfigInvalid, severity: "error", message: `The container's binding configuration does not bind the application "${descriptor.name}".`, hint: "Export default defineBindings(app, { ... }) from the bindings module, importing app from the application's infra.ts." }));
  const parts = artifact === undefined ? undefined : manifestParts(artifact);
  if (artifact !== undefined && (parts!.name !== descriptor.name || artifact.descriptor.application !== descriptor.name))
    throw new HolqaError(mismatch(`The artifact was packaged for the application "${artifact.descriptor.application}", but it runs "${descriptor.name}".`, "Package the application again with holqa package.", { application: descriptor.name }));

  const resolved = resolveBindings(options.bindings);
  if (resolved.diagnostics.some(diagnostic => diagnostic.severity === "error"))
    throw new HolqaError(resolved.diagnostics);
  if (artifact !== undefined) {
    const current = createBindingManifest(inspectBindings(resolved, { handlers: parts!.handlers, ...options.limits === undefined ? {} : { limits: options.limits } }), { applicationManifest: artifact.descriptor.manifest });
    const fields = differingFields(artifact.bindingManifest, JSON.parse(JSON.stringify(current)));
    if (fields.length > 0)
      throw new HolqaError(mismatch(`The binding "${resolved.name}" resolved at start differs from the packaged bindings.json in ${fields.join(", ")}.`, "Non-secret provider settings are fixed when packaging; package again for this environment, and use credential references for values that differ between deployments.", { fields }));
  }
  const binding = createBinding(resolved);
  const log = options.log ?? jsonLineSink();
  const runtime = createRuntime({
    app: options.app,
    handlers: options.handlers,
    binding,
    env,
    log,
    ...options.limits === undefined ? {} : { limits: options.limits },
    ...options.telemetry === undefined ? {} : { telemetry: options.telemetry }
  });
  const problems = validateBindings(resolved, { handlers: runtime.handlers, ...options.limits === undefined ? {} : { limits: options.limits } });
  if (problems.some(diagnostic => diagnostic.severity === "error"))
    throw new HolqaError(problems);

  const server = await serve(runtime, { port: settings.port, hostname: settings.hostname, maxRequestBodySize: settings.maxRequestBodySize, health: probePaths });
  const stopOptions = { graceMs: settings.graceMs, forceMs: settings.forceMs };
  const removeSignals = options.signals === false ? () => {} : stopOnSignals(server, stopOptions);
  log({ level: "info", time: new Date().toISOString(), message: "container serving", url: server.url.href, binding: resolved.name, ...artifact === undefined ? {} : { manifest: artifact.descriptor.manifest } });
  return Object.freeze({
    url: server.url,
    port: server.port,
    runtime,
    stop: async () => {
      removeSignals();
      await server.stop(stopOptions);
    }
  });
}

/**
 * The entry point of a packaged application: makes the artifact directory the
 * working directory (so relative paths such as static site roots and local
 * state resolve inside it), starts the container and, when
 * starting fails, writes the diagnostics as one JSON line to standard error
 * (never with secret values) and exits with status 1 so the platform restarts
 * or reports the deployment.
 *
 * @param options - As for {@link startContainer}.
 * @returns The running container.
 */
export async function runContainer(options: ContainerOptions): Promise<RunningContainer> {
  try {
    if (options.directory !== undefined)
      process.chdir(options.directory);
    return await startContainer(options);
  } catch (error) {
    const diagnostics = diagnosticsOf(error);
    process.stderr.write(`${JSON.stringify({ level: "error", time: new Date().toISOString(), message: "container failed to start", diagnostics: diagnostics.length > 0 ? diagnostics : [{ code: diagnosticCodes.runtimeStartFailed, severity: "error", message: error instanceof Error ? error.message : String(error) }] })}\n`);
    process.exit(1);
  }
}