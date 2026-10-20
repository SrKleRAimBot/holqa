import type {
  BindingProvider,
  ExecutionCapabilities,
  JsonObject,
  ProviderContext,
  ProviderInstance
} from "@holqa/core";

import { resolve } from "node:path";

import {
  bindingFailure,
  bindingProtocolVersion,
  HolqaError
} from "@holqa/core";
import { createLocalStaticSites } from "@holqa/local";

/** Settings of {@link container.host}. */
export interface ContainerHostOptions {
  /** The provider's name. Default `container`. */
  readonly name?: string;
  /**
   * The directory static sites' directories are relative to: the artifact
   * directory, where `holqa package` copies them. Default the working
   * directory when the binding starts (the image's `WORKDIR`).
   */
  readonly root?: string;
  /** The most concurrent invocations the host allows, when the deployment imposes a limit. */
  readonly maxConcurrency?: number;
  /** The longest invocation the host allows, in milliseconds, when the deployment imposes one. */
  readonly maxTimeoutMs?: number;
}

/**
 * Creates the execution host of a conventional Bun container: a resource
 * provider for the `execution`, `http.api` and `static.site` contracts.
 * The process runs Holqa's shared runtime (`@holqa/runtime-bun`) for HTTP
 * requests and, because it is long-running, for background deliveries from
 * queue, storage and schedule providers. Static sites are served from files
 * next to the application, with single-page fallback.
 *
 * It provisions nothing and needs no credentials. Pair it with resource
 * providers for queues, buckets and schedules, and with configuration and
 * telemetry services.
 *
 * @example
 * ```ts
 * defineBindings(app, { name: "production", kinds: { "http.api": container.host(), "queue": rabbitmq.queues({ url: credentialRef("QUEUE_URL") }) } });
 * ```
 *
 * @param options - Name, static site root and the host's limits.
 * @returns The host provider.
 * @throws {HolqaError} `HOLQA_BINDING_CONFIG_INVALID` for invalid settings.
 */
function host(options: ContainerHostOptions = {}): BindingProvider<"http.api" | "static.site"> {
  const name = options.name ?? "container";
  const problems: string[] = [];
  if (options.root !== undefined && (typeof options.root !== "string" || options.root === ""))
    problems.push("\"root\" must be a directory path.");
  for (const field of ["maxConcurrency", "maxTimeoutMs"] as const) {
    const value = options[field];
    if (value !== undefined && !(Number.isSafeInteger(value) && value >= 1))
      problems.push(`"${field}" must be a whole number of at least 1.`);
  }
  if (problems.length > 0)
    throw new HolqaError(problems.map(problem => bindingFailure("configuration", { binding: name, message: `container.host: ${problem}` })));
  const execution: ExecutionCapabilities = Object.freeze({
    runtimes: Object.freeze(["bun"]),
    mode: "long-running",
    ...options.maxConcurrency === undefined ? {} : { maxConcurrency: options.maxConcurrency },
    ...options.maxTimeoutMs === undefined ? {} : { maxTimeoutMs: options.maxTimeoutMs }
  });
  // The root is recorded as given so binding manifests stay the same on every machine; "." is the working directory.
  const settings: JsonObject = Object.freeze({ root: options.root ?? "." });
  return Object.freeze({
    bindingProtocol: bindingProtocolVersion,
    provider: "holqa.container",
    name,
    role: "resource",
    contracts: Object.freeze({ "execution": 1, "http.api": 1, "static.site": 1 }),
    resources: Object.freeze({ "http.api": Object.freeze({}), "static.site": Object.freeze({ spaFallback: true }) }),
    services: Object.freeze({}),
    execution,
    topology: Object.freeze({ delivery: "none", state: "process" }),
    settings,
    /**
     * Serves static sites from the root, resolved against the working directory.
     *
     * @param _context - Unused: the host needs no credentials.
     * @returns The instance with the static site driver.
     */
    open: async (_context: ProviderContext): Promise<ProviderInstance> => Object.freeze({
      drivers: Object.freeze({ "static.site": createLocalStaticSites(resolve(options.root ?? ".")) })
    })
  });
}

/** Providers of the conventional Bun container runtime. */
export const container = Object.freeze({ host });