import type {
  Diagnostic,
  Result,
  TelemetryAttributes
} from "@holqa/core";

import type { OtlpHttpExporterOptions } from "@/otlp-http-exporter";

import {
  createDiagnostic,
  diagnosticCodes,
  err,
  ok
} from "@holqa/core";

/** Environment variables by name, as `process.env` provides them. */
export type OtelEnvironment = Readonly<Record<string, string | undefined>>;

/** Telemetry settings read from the standard OpenTelemetry environment variables. */
export interface OtelEnvironmentSettings {
  /** Settings for `createOtlpHttpExporter`; absent when no OTLP endpoint is configured. */
  readonly exporter?: OtlpHttpExporterOptions;
  /** From `OTEL_SERVICE_NAME`. */
  readonly serviceName?: string;
  /** From `OTEL_RESOURCE_ATTRIBUTES`. */
  readonly resource?: TelemetryAttributes;
  /** From `OTEL_TRACES_SAMPLER` and `OTEL_TRACES_SAMPLER_ARG`. */
  readonly sampleRatio?: number;
  /** `true` when `OTEL_LOGS_EXPORTER` is `otlp`: log records are exported, which the runtime does not do by default. */
  readonly exportLogs?: boolean;
}

/** The protocols the exporter speaks. */
const supportedProtocol = "http/json";

/**
 * Parses an OpenTelemetry `key=value,key=value` list with percent-encoded values.
 *
 * @param value - The variable's value.
 * @param name - The variable's name, for messages.
 * @param problems - Where problems are recorded.
 * @param headers - Whether the entries are HTTP headers, whose names and values are checked.
 * @returns The entries.
 */
function parseList(value: string, name: string, problems: Diagnostic[], headers = false): Record<string, string> {
  // No prototype: keys come from the environment, and `__proto__` must stay an ordinary key.
  const entries = Object.create(null) as Record<string, string>;
  for (const item of value.split(",")) {
    if (item.trim() === "")
      continue;
    const separator = item.indexOf("=");
    if (separator <= 0) {
      // Never echo the value: header lists hold credentials.
      problems.push(problem(`${name} must be a comma-separated list of key=value pairs.`));
      continue;
    }
    let key: string;
    let decoded: string;
    try {
      key = decodeURIComponent(item.slice(0, separator).trim());
      decoded = decodeURIComponent(item.slice(separator + 1).trim());
    } catch {
      problems.push(problem(`${name} contains an invalid percent-encoding.`));
      continue;
    }
    // Header names are tokens and values may not contain control characters; never echo either.
    if (headers && (!/^[!#$%&'*+.^\w`|~-]+$/.test(key) || hasControlCharacter(decoded))) {
      problems.push(problem(`${name} contains a header name or value that HTTP does not allow.`));
      continue;
    }
    entries[key] = decoded;
  }
  return entries;
}

/**
 * Reports whether text contains a control character other than a tab, which HTTP header values may not hold.
 *
 * @param text - A header value.
 * @returns `true` when a character below U+0020 (except tab) or U+007F is present.
 */
function hasControlCharacter(text: string): boolean {
  return [...text].some((character) => {
    const code = character.charCodeAt(0);
    return (code < 0x20 && code !== 0x09) || code === 0x7F;
  });
}

/**
 * Builds a `HOLQA_TELEMETRY_CONFIG_INVALID` diagnostic.
 *
 * @param message - What is wrong.
 * @returns The diagnostic.
 */
function problem(message: string): Diagnostic {
  return createDiagnostic({ code: diagnosticCodes.telemetryConfigInvalid, severity: "error", message, hint: "See the OpenTelemetry environment variable specification; Holqa's exporter speaks OTLP/HTTP with JSON." });
}

/**
 * Reads the standard OpenTelemetry environment variables that apply to
 * Holqa's telemetry: OTLP endpoints, headers, time limits and protocol
 * (`OTEL_EXPORTER_OTLP_*`, also per signal), the exporters selected per
 * signal (`OTEL_TRACES_EXPORTER`, `OTEL_METRICS_EXPORTER`,
 * `OTEL_LOGS_EXPORTER`: `otlp` or `none`), `OTEL_SDK_DISABLED`,
 * `OTEL_SERVICE_NAME`, `OTEL_RESOURCE_ATTRIBUTES` and the trace sampler.
 *
 * No exporter is configured unless an endpoint variable is set, so an
 * unconfigured environment never sends telemetry anywhere. Settings the
 * exporter cannot honour, such as the `grpc` or `http/protobuf` protocol or
 * an unknown sampler, are reported instead of being ignored.
 *
 * @example
 * ```ts
 * const settings = readOtelEnvironment(process.env);
 * if (!settings.ok) throw new HolqaError(settings.error);
 * const exporters = settings.value.exporter === undefined ? [] : [createOtlpHttpExporter(settings.value.exporter)];
 * ```
 *
 * @param env - The environment variables.
 * @returns The settings, or every `HOLQA_TELEMETRY_CONFIG_INVALID` problem found. Header values never appear in diagnostics.
 */
export function readOtelEnvironment(env: OtelEnvironment): Result<OtelEnvironmentSettings, readonly Diagnostic[]> {
  const problems: Diagnostic[] = [];
  /**
   * Reads a variable, treating an empty value as unset.
   *
   * @param name - The variable's name.
   * @returns The trimmed value, or `undefined`.
   */
  const read = (name: string): string | undefined => {
    const value = env[name]?.trim();
    return value === undefined || value === "" ? undefined : value;
  };
  if (read("OTEL_SDK_DISABLED")?.toLowerCase() === "true")
    return ok({});

  const serviceName = read("OTEL_SERVICE_NAME");
  const resourceText = read("OTEL_RESOURCE_ATTRIBUTES");
  const resource = resourceText === undefined ? undefined : parseList(resourceText, "OTEL_RESOURCE_ATTRIBUTES", problems);

  let sampleRatio: number | undefined;
  const sampler = read("OTEL_TRACES_SAMPLER");
  if (sampler !== undefined) {
    if (sampler === "parentbased_always_on") {
      sampleRatio = 1;
    } else if (sampler === "parentbased_always_off") {
      sampleRatio = 0;
    } else if (sampler === "parentbased_traceidratio") {
      const argument = read("OTEL_TRACES_SAMPLER_ARG");
      const ratio = argument === undefined ? 1 : Number(argument);
      if (Number.isFinite(ratio) && ratio >= 0 && ratio <= 1)
        sampleRatio = ratio;
      else
        problems.push(problem(`OTEL_TRACES_SAMPLER_ARG must be a number from 0 to 1, not "${argument}".`));
    } else {
      problems.push(problem(`OTEL_TRACES_SAMPLER "${sampler}" is not supported; Holqa always follows a caller's sampling decision, so only the parent-based samplers apply: parentbased_always_on, parentbased_always_off and parentbased_traceidratio.`));
    }
  }

  const endpoint = read("OTEL_EXPORTER_OTLP_ENDPOINT");
  const signalEndpoints = { traces: read("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"), metrics: read("OTEL_EXPORTER_OTLP_METRICS_ENDPOINT"), logs: read("OTEL_EXPORTER_OTLP_LOGS_ENDPOINT") };
  const configured = endpoint !== undefined || Object.values(signalEndpoints).some(value => value !== undefined);
  const signals = ["traces", "metrics", "logs"] as const;
  const upper = { traces: "TRACES", metrics: "METRICS", logs: "LOGS" } as const;
  const enabled: Record<(typeof signals)[number], boolean> = { traces: true, metrics: true, logs: false };
  for (const signal of signals) {
    const selected = read(`OTEL_${upper[signal]}_EXPORTER`);
    if (selected === undefined)
      continue;
    if (selected !== "otlp" && selected !== "none")
      problems.push(problem(`OTEL_${upper[signal]}_EXPORTER "${selected}" is not supported; use "otlp" or "none".`));
    else
      enabled[signal] = selected === "otlp";
  }

  // Exporter settings only matter when an endpoint is configured: environments
  // that set them globally for other tools are not rejected otherwise.
  let headers: Record<string, string> = {};
  const signalHeaders: Partial<Record<(typeof signals)[number], Record<string, string>>> = {};
  let timeoutMs: number | undefined;
  if (configured) {
    for (const name of ["OTEL_EXPORTER_OTLP_PROTOCOL", ...signals.map(signal => `OTEL_EXPORTER_OTLP_${upper[signal]}_PROTOCOL`)]) {
      const protocol = read(name);
      if (protocol !== undefined && protocol !== supportedProtocol)
        problems.push(problem(`${name} "${protocol}" is not supported; Holqa's exporter sends OTLP/HTTP with JSON ("${supportedProtocol}"), which OpenTelemetry Collectors accept on the same port as protobuf.`));
    }
    for (const prefix of ["OTEL_EXPORTER_OTLP", ...signals.map(signal => `OTEL_EXPORTER_OTLP_${upper[signal]}`)]) {
      const compression = read(`${prefix}_COMPRESSION`);
      if (compression !== undefined && compression !== "none")
        problems.push(problem(`${prefix}_COMPRESSION "${compression}" is not supported; the exporter sends uncompressed requests.`));
      for (const suffix of ["CERTIFICATE", "CLIENT_KEY", "CLIENT_CERTIFICATE"]) {
        if (read(`${prefix}_${suffix}`) !== undefined)
          problems.push(problem(`${prefix}_${suffix} is not supported: the exporter uses the Fetch API, which cannot load certificates; configure trust in the runtime instead.`));
      }
    }
    for (const signal of signals) {
      if (read(`OTEL_EXPORTER_OTLP_${upper[signal]}_TIMEOUT`) !== undefined)
        problems.push(problem(`OTEL_EXPORTER_OTLP_${upper[signal]}_TIMEOUT is not supported; set OTEL_EXPORTER_OTLP_TIMEOUT, which applies to every signal.`));
    }
    const propagators = read("OTEL_PROPAGATORS");
    if (propagators !== undefined && propagators !== "tracecontext")
      problems.push(problem(`OTEL_PROPAGATORS "${propagators}" is not supported; Holqa propagates W3C trace context ("tracecontext") only.`));
    const headersText = read("OTEL_EXPORTER_OTLP_HEADERS");
    headers = headersText === undefined ? {} : parseList(headersText, "OTEL_EXPORTER_OTLP_HEADERS", problems, true);
    for (const signal of signals) {
      const text = read(`OTEL_EXPORTER_OTLP_${upper[signal]}_HEADERS`);
      // A signal's headers go only to that signal's endpoint.
      if (text !== undefined)
        signalHeaders[signal] = parseList(text, `OTEL_EXPORTER_OTLP_${upper[signal]}_HEADERS`, problems, true);
    }
    const timeoutText = read("OTEL_EXPORTER_OTLP_TIMEOUT");
    timeoutMs = timeoutText === undefined ? undefined : Number(timeoutText);
    if (timeoutMs !== undefined && !(Number.isSafeInteger(timeoutMs) && timeoutMs >= 1))
      problems.push(problem(`OTEL_EXPORTER_OTLP_TIMEOUT must be a whole number of milliseconds of at least 1, not "${timeoutText}".`));
    for (const [name, value] of [["OTEL_EXPORTER_OTLP_ENDPOINT", endpoint], ...signals.map(signal => [`OTEL_EXPORTER_OTLP_${upper[signal]}_ENDPOINT`, signalEndpoints[signal]] as const)] as const) {
      if (value !== undefined && !(URL.canParse(value) && /^https?:$/.test(new URL(value).protocol)))
        problems.push(problem(`${name} must be an absolute http or https URL.`));
    }
  }
  if (problems.length > 0)
    return err(problems);

  // Without a base endpoint, only signals with an endpoint of their own are sent.
  const active = {
    traces: enabled.traces && (endpoint !== undefined || signalEndpoints.traces !== undefined),
    metrics: enabled.metrics && (endpoint !== undefined || signalEndpoints.metrics !== undefined),
    logs: enabled.logs && (endpoint !== undefined || signalEndpoints.logs !== undefined)
  };
  const exporter: OtlpHttpExporterOptions | undefined = !(active.traces || active.metrics || active.logs)
    ? undefined
    : {
      ...endpoint === undefined ? {} : { endpoint },
      ...signalEndpoints.traces === undefined ? {} : { tracesEndpoint: signalEndpoints.traces },
      ...signalEndpoints.metrics === undefined ? {} : { metricsEndpoint: signalEndpoints.metrics },
      ...signalEndpoints.logs === undefined ? {} : { logsEndpoint: signalEndpoints.logs },
      ...Object.keys(headers).length === 0 ? {} : { headers: { ...headers } },
      ...signalHeaders.traces === undefined ? {} : { tracesHeaders: { ...signalHeaders.traces } },
      ...signalHeaders.metrics === undefined ? {} : { metricsHeaders: { ...signalHeaders.metrics } },
      ...signalHeaders.logs === undefined ? {} : { logsHeaders: { ...signalHeaders.logs } },
      ...timeoutMs === undefined ? {} : { timeoutMs },
      signals: active
    };
  return ok({
    ...exporter === undefined ? {} : { exporter },
    ...serviceName === undefined ? {} : { serviceName },
    ...resource === undefined ? {} : { resource },
    ...sampleRatio === undefined ? {} : { sampleRatio },
    ...active.logs ? { exportLogs: true } : {}
  });
}