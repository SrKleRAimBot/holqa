# @holqa/opentelemetry

> **Status:** **Implemented** (OTLP/HTTP JSON export of traces, metrics and logs; the standard `OTEL_*` environment variables; the `otlp.telemetry` service provider for binding configurations). Private and unpublished. A bridge to `@opentelemetry/api` and OTLP over protobuf or gRPC are **Planned**.

OpenTelemetry interoperability for Holqa. Holqa's runtime records telemetry on the OpenTelemetry data model
([ADR 0027](../../../docs/architecture/decisions/0027-observability-telemetry-and-local-inspection.md)); this package
sends it to any OTLP/HTTP receiver, such as an OpenTelemetry Collector or a backend that accepts OTLP directly. It
uses only the Fetch API and has no OpenTelemetry package as a dependency, so it runs on any standards-compliant
JavaScript runtime.

```ts
import { createOtlpHttpExporter, readOtelEnvironment } from "@holqa/opentelemetry";
import { createRuntime } from "@holqa/runtime-bun";

const settings = readOtelEnvironment(process.env);
if (!settings.ok)
  throw new HolqaError(settings.error);
const { exporter, serviceName, resource, sampleRatio, exportLogs } = settings.value;

const runtime = createRuntime({
  app,
  handlers,
  telemetry: {
    exporters: exporter === undefined ? [] : [createOtlpHttpExporter(exporter)],
    ...serviceName === undefined ? {} : { serviceName },
    ...resource === undefined ? {} : { resource },
    ...sampleRatio === undefined ? {} : { sampleRatio },
    ...exportLogs === undefined ? {} : { exportLogs }
  }
});
```

`holqa dev`, `holqa invoke` and `holqa cron run` do this for you when `OTEL_EXPORTER_OTLP_ENDPOINT` is set.

## Exports

| Export | Kind | Description |
| --- | --- | --- |
| `createOtlpHttpExporter(options?)` | Function | A `TelemetryExporter` named `otlp-http`. Posts OTLP/JSON to `<endpoint>/v1/traces`, `/v1/metrics` and `/v1/logs` (default endpoint `http://localhost:4318`), or to per-signal URLs; `headers` for every signal, `tracesHeaders`, `metricsHeaders` and `logsHeaders` for one signal, `timeoutMs` (default 10 000), `signals` and an injectable `fetch`. Honours the runtime's `TelemetryExportOptions.signal`. Throws `HOLQA_TELEMETRY_CONFIG_INVALID` for an endpoint that is not an absolute http or https URL or an invalid time limit. |
| `OtlpHttpExporterOptions`, `OtlpSignals` | Types | Its settings. |
| `readOtelEnvironment(env)` | Function | Reads `OTEL_EXPORTER_OTLP_ENDPOINT` and the per-signal endpoints, `OTEL_EXPORTER_OTLP_HEADERS` (every signal) and the per-signal headers (that signal only), `OTEL_EXPORTER_OTLP_TIMEOUT`, `OTEL_EXPORTER_OTLP_PROTOCOL` (only `http/json`), compression (only `none`), `OTEL_PROPAGATORS` (only `tracecontext`), `OTEL_TRACES_EXPORTER`, `OTEL_METRICS_EXPORTER`, `OTEL_LOGS_EXPORTER` (`otlp` or `none`; logs are off unless `otlp`), `OTEL_SDK_DISABLED`, `OTEL_SERVICE_NAME`, `OTEL_RESOURCE_ATTRIBUTES` and `OTEL_TRACES_SAMPLER` (only the parent-based samplers) with `OTEL_TRACES_SAMPLER_ARG`. Certificate settings, per-signal timeouts and header names or values HTTP disallows are rejected. Exporter settings are only checked when an endpoint is configured. Returns `Result<OtelEnvironmentSettings, readonly Diagnostic[]>`; no exporter is configured without an endpoint variable. Header values never appear in diagnostics. |
| `OtelEnvironment`, `OtelEnvironmentSettings` | Types | Its input and result. |
| `encodeOtlpTraces`, `encodeOtlpMetrics`, `encodeOtlpLogs` | Functions | Encode spans, metrics and log records as OTLP `Export*ServiceRequest` bodies in OTLP/JSON: hexadecimal identifiers, decimal-string nanosecond timestamps and 64-bit integers, numeric enums, cumulative temporality. |
| `toAnyValue`, `toKeyValues`, `toUnixNano`, `otlpScope`, `OtlpAnyValue`, `OtlpKeyValue` | Functions, constant, types | Encoding helpers; the instrumentation scope is `holqa`. |

## Behavior and limitations

- One request per export call, no retries. A non-2xx answer, an unreachable receiver or a request slower than the
  time limit rejects the call; the runtime then drops that batch for this exporter and logs
  `HOLQA_TELEMETRY_EXPORT_FAILED` at most once a minute. Error messages name the endpoint's origin and path only,
  never credentials in its user information, query or headers.
- OTLP/HTTP with JSON only. OpenTelemetry Collectors accept JSON on their OTLP/HTTP port; `grpc` and `http/protobuf`
  are reported as unsupported instead of being replaced silently.
- Sums and histograms are cumulative; there are no exemplars.
- Without a base endpoint, only signals with an endpoint of their own are sent.
- Spans created with `@opentelemetry/api` by application code do not join Holqa's traces yet (**Planned**).

Tests run the exporter against a local OTLP/HTTP receiver on Bun 1.3.13; [`examples/observability`](../../../examples/observability/README.md)
exercises it end to end with a runtime and with the built CLI.

Boundaries: depends on `@holqa/core` only; runtime-neutral (no `bun`, `bun:*` or `node:*` imports).

In a binding configuration, select the destination per environment with `services: { telemetry: otlp.telemetry({ endpoint }) }`
(see the [observability guide](../../../docs/guides/observability.md#select-the-telemetry-destination-in-a-binding-configuration)).
