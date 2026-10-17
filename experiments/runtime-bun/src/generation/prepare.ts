import type { Result } from "@holqa/core";
import type {
  InvocationLogger,
  JsonObject,
  RuntimeBinding
} from "@holqa/experiment-model";

import type { RuntimeDiagnostic } from "@/diagnostics";
import type { Registry } from "@/generation/registry";
import type {
  BindingBackend,
  HostInvocation,
  LogEntry
} from "@/hosts/types";

import {
  err,
  ok
} from "@holqa/core";
import {
  bindApp,
  experimentCodes
} from "@holqa/experiment-model";

import { holqaError } from "@/diagnostics";
import { resolveConfig } from "@/generation/config";
import {
  checkSyntax,
  importGraph
} from "@/generation/load-graph";
import { buildRegistry } from "@/generation/registry";

/** A loaded, validated and bound generation, before it is wrapped by a host. */
export interface PreparedGeneration {
  readonly registry: Registry;
  /** Runs a handler with an invocation context built from `invocation`. */
  readonly invoke: (handlerId: string, input: unknown, invocation: HostInvocation) => Promise<unknown>;
  /** Removes the runtime binding from this generation's application instance. */
  readonly unbind: () => void;
}

/**
 * Builds the application binding: queue and bucket operations go to the
 * runtime-owned backend, configuration comes from validated values.
 *
 * @param backend - Runtime-owned resource state.
 * @param config - Validated configuration values.
 * @returns The binding for this generation's application instance.
 */
function createBinding(backend: BindingBackend, config: ReadonlyMap<string, unknown>): RuntimeBinding {
  return {
    queue: queueId => ({ send: async message => backend.queueSend(queueId, message) }),
    bucket: bucketId => ({
      put: async (key, body, options) => backend.bucketPut(bucketId, key, body, options?.contentType),
      get: async key => backend.bucketGet(bucketId, key)
    }),
    config: (name) => {
      if (!config.has(name))
        throw holqaError(experimentCodes.configInvalid, `Configuration entry "${name}" is not declared.`);
      return config.get(name);
    }
  };
}

/**
 * Parses, evaluates, validates, configures and binds one generation. Nothing
 * is bound unless every step succeeds.
 *
 * @param options - Root, entry, raw configuration, backend and log sink.
 * @param options.root - The application root.
 * @param options.entry - The registry file relative to the root.
 * @param options.env - Raw configuration values.
 * @param options.generation - The generation number, recorded on log entries.
 * @param options.backend - Runtime-owned resource state.
 * @param options.onLog - Receives handler log entries.
 * @param options.cacheBust - Optional query appended to direct module specifiers (in-process strategy).
 * @returns The prepared generation, or every diagnostic found.
 */
export async function prepareGeneration(options: {
  readonly root: string;
  readonly entry: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly generation: number;
  readonly backend: BindingBackend;
  readonly onLog: (entry: LogEntry) => void;
  readonly cacheBust?: string;
}): Promise<Result<PreparedGeneration, RuntimeDiagnostic[]>> {
  // A module that fails to parse poisons Bun's registry for its path: the next
  // import of it in the same module graph never settles. Parse everything first.
  const syntax = await checkSyntax(options.root);
  if (syntax.length > 0)
    return err(syntax);
  const graph = await importGraph(options.root, options.entry, options.cacheBust === undefined ? {} : { cacheBust: options.cacheBust });
  if (!graph.ok)
    return graph;
  const registry = buildRegistry(graph.value);
  if (!registry.ok)
    return registry;
  const config = await resolveConfig(graph.value.app, options.env);
  if (!config.ok)
    return config;

  const unbind = bindApp(graph.value.app, createBinding(options.backend, config.value));

  /**
   * Creates the structured logger handed to one invocation.
   *
   * @param invocationId - The invocation the entries belong to.
   * @returns A logger that forwards entries to the runtime's log sink.
   */
  const loggerFor = (invocationId: string): InvocationLogger => {
    /**
     * Creates the logging function for one level.
     *
     * @param level - The log level.
     * @returns A function that forwards one entry.
     */
    const at = (level: LogEntry["level"]) => (message: string, fields: JsonObject = {}): void => {
      options.onLog({ level, message, fields, invocationId, generation: options.generation });
    };
    return { info: at("info"), warn: at("warn"), error: at("error") };
  };

  return ok({
    registry: registry.value,
    invoke: async (handlerId, input, invocation) => {
      const handler = registry.value.handlers.get(handlerId);
      if (handler === undefined)
        throw holqaError(experimentCodes.handlerNotFound, `Handler "${handlerId}" is not registered.`);
      return handler.descriptor.invoke(input, { invocationId: invocation.invocationId, signal: invocation.signal, metadata: invocation.metadata, log: loggerFor(invocation.invocationId) });
    },
    unbind
  });
}