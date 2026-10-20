import type { TelemetryExporter } from "@holqa/core";

import {
  createDiagnostic,
  diagnosticCodes,
  HolqaError
} from "@holqa/core";

import {
  encodeOtlpLogs,
  encodeOtlpMetrics,
  encodeOtlpTraces
} from "@/otlp-json";

/** Which signals an OTLP exporter sends. */
export interface OtlpSignals {
  /** Default `true`. */
  readonly traces?: boolean;
  /** Default `true`. */
  readonly metrics?: boolean;
  /** Default `true`; a runtime only hands over log records when its `telemetry.exportLogs` is set. */
  readonly logs?: boolean;
}

/** Settings of {@link createOtlpHttpExporter}. */
export interface OtlpHttpExporterOptions {
  /**
   * The base URL of an OTLP/HTTP receiver, for example an OpenTelemetry
   * Collector at `http://localhost:4318`. Signals are posted to
   * `<endpoint>/v1/traces`, `/v1/metrics` and `/v1/logs`. Default `http://localhost:4318`.
   */
  readonly endpoint?: string;
  /** A complete URL for traces, used as-is instead of `<endpoint>/v1/traces`. */
  readonly tracesEndpoint?: string;
  /** A complete URL for metrics, used as-is instead of `<endpoint>/v1/metrics`. */
  readonly metricsEndpoint?: string;
  /** A complete URL for logs, used as-is instead of `<endpoint>/v1/logs`. */
  readonly logsEndpoint?: string;
  /** Headers sent with every request, for example an authorization header. Never logged or included in errors. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Headers sent only with trace requests, in addition to `headers`. */
  readonly tracesHeaders?: Readonly<Record<string, string>>;
  /** Headers sent only with metric requests, in addition to `headers`. */
  readonly metricsHeaders?: Readonly<Record<string, string>>;
  /** Headers sent only with log requests, in addition to `headers`. */
  readonly logsHeaders?: Readonly<Record<string, string>>;
  /** How long one request may take, in milliseconds. Default 10 000. */
  readonly timeoutMs?: number;
  readonly signals?: OtlpSignals;
  /** The Fetch implementation. Default: the global `fetch`. */
  readonly fetch?: (input: string, init: RequestInit) => Promise<Response>;
}

/**
 * Describes an endpoint for error messages without credentials: its origin
 * and path, never its user information or query.
 *
 * @param url - An endpoint that may carry credentials in its user information or query.
 * @returns `origin + pathname`.
 */
function safeEndpoint(url: URL): string {
  return `${url.origin}${url.pathname}`;
}

/**
 * Resolves and validates one signal's endpoint.
 *
 * @param explicit - The signal's own URL, if configured.
 * @param base - The receiver's base URL, used when the signal has no URL of its own.
 * @param path - The signal's path below the base, for example `v1/traces`.
 * @returns The URL.
 * @throws {HolqaError} `HOLQA_TELEMETRY_CONFIG_INVALID` for a URL that is not absolute http or https.
 */
function endpointOf(explicit: string | undefined, base: string, path: string): URL {
  const candidate = explicit ?? `${base.replace(/\/+$/, "")}/${path}`;
  if (!URL.canParse(candidate) || !/^https?:$/.test(new URL(candidate).protocol))
    throw new HolqaError(createDiagnostic({ code: diagnosticCodes.telemetryConfigInvalid, severity: "error", message: `The OTLP endpoint for ${path.slice(3)} must be an absolute http or https URL.` }));

  return new URL(candidate);
}

/**
 * Creates a telemetry exporter that posts spans, metrics and log records to
 * an OTLP/HTTP receiver (an OpenTelemetry Collector, or a backend that
 * accepts OTLP directly) using the OTLP/JSON encoding. It has no
 * OpenTelemetry SDK dependency and uses only the Fetch API.
 *
 * Each call sends one request and rejects when the receiver answers with
 * anything but 2xx, or does not answer in time; the runtime's export
 * pipeline then drops that batch and reports the failure. There are no
 * retries, so an unavailable receiver costs at most one bounded request per
 * export interval.
 *
 * @example
 * ```ts
 * const runtime = createRuntime({
 *   app,
 *   handlers,
 *   telemetry: { exporters: [createOtlpHttpExporter({ endpoint: "http://localhost:4318" })] }
 * });
 * ```
 *
 * @param options - The endpoint, headers, time limit and signals.
 * @returns The exporter, named `otlp-http`.
 * @throws {HolqaError} `HOLQA_TELEMETRY_CONFIG_INVALID` for an invalid endpoint or time limit.
 */
export function createOtlpHttpExporter(options: OtlpHttpExporterOptions = {}): TelemetryExporter {
  const base = options.endpoint ?? "http://localhost:4318";
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!(Number.isSafeInteger(timeoutMs) && timeoutMs >= 1))
    throw new HolqaError(createDiagnostic({ code: diagnosticCodes.telemetryConfigInvalid, severity: "error", message: "The OTLP time limit must be a whole number of milliseconds of at least 1." }));
  const signals = { traces: true, metrics: true, logs: true, ...options.signals };
  const traces = signals.traces ? endpointOf(options.tracesEndpoint, base, "v1/traces") : undefined;
  const metrics = signals.metrics ? endpointOf(options.metricsEndpoint, base, "v1/metrics") : undefined;
  const logs = signals.logs ? endpointOf(options.logsEndpoint, base, "v1/logs") : undefined;
  const send = options.fetch ?? ((input: string, init: RequestInit) => fetch(input, init));
  /**
   * Builds the headers of one signal's requests; a signal's own headers never go to another signal's endpoint.
   *
   * @param own - The signal's own headers.
   * @returns The shared headers, the signal's headers and the content type.
   */
  const headersOf = (own: Readonly<Record<string, string>> | undefined): Record<string, string> => ({ ...options.headers, ...own, "content-type": "application/json" });

  /**
   * Posts one request body.
   *
   * @param url - Where to.
   * @param headers - The signal's headers.
   * @param body - The OTLP request.
   * @param options - The pipeline's abort signal, if any.
   * @param options.signal - Aborted when the pipeline gave up on the call.
   * @returns A promise that settles once the receiver accepted it.
   * @throws {Error} When the receiver is unreachable, too slow or answers with an error status.
   */
  const post = async (url: URL, headers: Record<string, string>, body: object, options?: { readonly signal: AbortSignal }): Promise<void> => {
    let response: Response;
    try {
      const signal = options === undefined ? AbortSignal.timeout(timeoutMs) : AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)]);
      response = await send(url.href, { method: "POST", headers, body: JSON.stringify(body), signal });
    } catch (error) {
      const reason = error instanceof Error && error.name === "TimeoutError" ? `no answer within ${timeoutMs} ms` : error instanceof Error ? error.message : String(error);
      throw new Error(`OTLP export to ${safeEndpoint(url)} failed: ${reason}`);
    }
    // Release the connection; the body (a partial success report at most) is not needed.
    await response.body?.cancel().catch(() => undefined);
    if (!response.ok)
      throw new Error(`OTLP export to ${safeEndpoint(url)} was rejected with HTTP ${response.status}.`);
  };

  return Object.freeze({
    name: "otlp-http",
    ...traces === undefined ? {} : { exportSpans: (spans, resource, exportOptions) => post(traces, headersOf(options.tracesHeaders), encodeOtlpTraces(spans, resource), exportOptions) },
    ...metrics === undefined ? {} : { exportMetrics: (records, resource, exportOptions) => post(metrics, headersOf(options.metricsHeaders), encodeOtlpMetrics(records, resource), exportOptions) },
    ...logs === undefined ? {} : { exportLogs: (records, resource, exportOptions) => post(logs, headersOf(options.logsHeaders), encodeOtlpLogs(records, resource), exportOptions) }
  } satisfies TelemetryExporter);
}