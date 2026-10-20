import type {
  BindingProvider,
  CredentialReference,
  JsonObject,
  ProviderContext,
  ProviderInstance
} from "@holqa/core";

import type { OtlpSignals } from "@/otlp-http-exporter";

import {
  bindingFailure,
  bindingProtocolVersion,
  HolqaError,
  isCredentialReference
} from "@holqa/core";

import { createOtlpHttpExporter } from "@/otlp-http-exporter";

/** Settings of {@link otlp.telemetry}. */
export interface OtlpTelemetryOptions {
  /** The base URL of an OTLP/HTTP receiver, for example an OpenTelemetry Collector at `http://collector:4318`. */
  readonly endpoint: string;
  /** The provider's name. Default `otlp`. */
  readonly name?: string;
  /** Headers sent with every request, as credential references, for example `{ authorization: credentialRef("OTLP_AUTHORIZATION") }`. */
  readonly headers?: Readonly<Record<string, CredentialReference>>;
  readonly signals?: OtlpSignals;
  /** How long one export request may take, in milliseconds. Default 10 000. */
  readonly timeoutMs?: number;
  /** The Fetch implementation; replaceable in tests. */
  readonly fetch?: (input: string, init: RequestInit) => Promise<Response>;
}

/**
 * Creates a telemetry service provider that exports spans, metrics and (when
 * the runtime hands them over) log records to an OTLP/HTTP receiver, so the
 * telemetry destination is selected independently of compute and resources:
 * `defineBindings(app, { services: { telemetry: otlp.telemetry({ endpoint }) } })`.
 *
 * Exports run in the runtime's bounded background pipeline: a receiver that is
 * down loses only the affected batches and never fails an invocation. Header
 * values are credential references, resolved when the binding starts and
 * never logged.
 *
 * @example
 * ```ts
 * otlp.telemetry({ endpoint: "http://collector:4318", headers: { authorization: credentialRef("OTLP_AUTHORIZATION") } });
 * ```
 *
 * @param options - Receiver URL, header references, signals and time limit.
 * @returns A service provider for the `telemetry` service.
 * @throws {HolqaError} `HOLQA_BINDING_CONFIG_INVALID` for an invalid endpoint, header or time limit.
 */
function telemetry(options: OtlpTelemetryOptions): BindingProvider<never, "telemetry"> {
  const name = options.name ?? "otlp";
  const problems: string[] = [];
  if (typeof options.endpoint !== "string" || !URL.canParse(options.endpoint) || !/^https?:$/.test(new URL(options.endpoint).protocol))
    problems.push("\"endpoint\" must be an absolute http or https URL.");
  else if (new URL(options.endpoint).username !== "" || new URL(options.endpoint).password !== "")
    problems.push("\"endpoint\" must not contain credentials; pass them as header references.");
  for (const [header, reference] of Object.entries(options.headers ?? {})) {
    if (!/^[\w-]+$/.test(header) || !isCredentialReference(reference))
      problems.push(`"headers.${header}" must be a header name with a credential reference value.`);
  }
  if (options.timeoutMs !== undefined && !(Number.isSafeInteger(options.timeoutMs) && options.timeoutMs >= 1))
    problems.push("\"timeoutMs\" must be a whole number of at least 1.");
  if (problems.length > 0)
    throw new HolqaError(problems.map(problem => bindingFailure("configuration", { binding: name, message: `otlp.telemetry: ${problem}` })));
  const headers = Object.entries(options.headers ?? {});
  const settings: JsonObject = Object.freeze({
    endpoint: options.endpoint,
    headers: Object.freeze(headers.map(([header]) => header).sort()),
    signals: Object.freeze({ traces: options.signals?.traces ?? true, metrics: options.signals?.metrics ?? true, logs: options.signals?.logs ?? true })
  });
  return Object.freeze({
    bindingProtocol: bindingProtocolVersion,
    provider: "holqa.otlp",
    name,
    role: "service",
    contracts: Object.freeze({ telemetry: 1 }),
    resources: Object.freeze({}),
    services: Object.freeze({ telemetry: true }),
    topology: Object.freeze({ delivery: "none", state: "shared", connectors: Object.freeze([`an OTLP/HTTP receiver at ${new URL(options.endpoint).origin}`]) }),
    settings,
    credentials: Object.freeze(headers.map(([, reference]) => reference)),
    /**
     * Resolves the header references and creates the exporter.
     *
     * @param context - The provider context, for credentials.
     * @returns The instance with one exporter.
     */
    open: async (context: ProviderContext): Promise<ProviderInstance> => Object.freeze({
      telemetry: Object.freeze([createOtlpHttpExporter({
        endpoint: options.endpoint,
        headers: Object.fromEntries(headers.map(([header, reference]) => [header, context.credential(reference)])),
        ...options.signals === undefined ? {} : { signals: options.signals },
        ...options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs },
        ...options.fetch === undefined ? {} : { fetch: options.fetch }
      })])
    })
  });
}

/** OpenTelemetry binding providers. */
export const otlp = Object.freeze({ telemetry });