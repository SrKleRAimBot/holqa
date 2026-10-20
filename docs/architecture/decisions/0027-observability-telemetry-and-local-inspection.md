# 0027. Observability: telemetry on the OpenTelemetry model and local inspection

- **Status:** Proposed (implemented)
- **Date:** 2026-10-20
- **Deciders:** Holqa maintainers
- **Refines:** [ADR 0023](0023-common-invocation-engine-and-http-rpc-execution.md) (structured logs of the dispatcher) and [ADR 0026](0026-event-safety-analysis-lineage-and-execution-guards.md) (event lineage)
- **Amends:** [ADR 0017](0017-package-layers-after-m0.md) (the tools layer: `@holqa/cli` may depend on `core`, `compiler`, `local`, `runtime-bun` and now `@holqa/opentelemetry`)

## Context

Every invocation already runs through one dispatcher ([ADR 0023](0023-common-invocation-engine-and-http-rpc-execution.md)) that writes structured JSON logs with correlation and lineage identifiers ([ADR 0026](0026-event-safety-analysis-lineage-and-execution-guards.md)). Developers and operators also need traces across HTTP and asynchronous boundaries, a small set of metrics, and a way to inspect executions locally, without being tied to one monitoring product.

Constraints:

- Holqa is infrastructure-neutral. Telemetry must reach any backend, and local development must work without a hosted observability account.
- OpenTelemetry is the common interoperability standard. Its JavaScript implementation describes tracing and metrics as stable, while the logs signal is still under development.
- OpenTelemetry's messaging conventions recommend span links for producer/consumer correlation in several asynchronous scenarios, rather than one continuous parent-child tree.
- Event lineage drives safety controls (depth limits, operation budgets). Telemetry sampling and retention must never weaken them.
- Telemetry must not affect invocations: an unavailable exporter or a full buffer must not slow down, fail or block handlers.
- Logs and telemetry must not leak declared secret values. Metric labels must not grow with traffic (no user, message, invocation or object identifiers).
- `@holqa/core` must stay dependency-free and runtime-neutral.

## Decision

1. **The OpenTelemetry data model and W3C trace context, without an SDK dependency.** `@holqa/core` defines the telemetry data model (spans, cumulative metrics, log records, resource) closely mirroring OpenTelemetry's, a `TelemetryExporter` interface, and W3C `traceparent` parsing and formatting. `@holqa/runtime-bun` records spans and metrics itself. No OpenTelemetry package is a dependency of any Holqa package.
2. **Telemetry trace context is separate from event lineage.** `DeliveryTrace` gains an optional `traceparent` next to the lineage fields. Sampling decides only whether spans are recorded and exported; lineage is always stored and depth limits and operation budgets always apply, sampled or not. An unsampled context is still propagated.
3. **Messaging spans are children of their publisher and link to it by default.** A processing span (`process <queue>` or `process <bucket>`, kind `consumer`) is a child of the producer or storage span that published the message or wrote the object, and always records a span link to it. `telemetry.messages: "link"` instead starts a new trace per delivery with only the link.
4. **A closed registry of framework metrics.** `frameworkMetrics` in `@holqa/core` lists every metric, its unit and the only attribute keys it may carry. Attributes outside the list are dropped before aggregation, and each metric tracks at most `maxSeriesPerMetric` (default 2 000) attribute combinations; further ones aggregate into a series marked `otel.metric.overflow`. Durations are in seconds. Names follow OpenTelemetry semantic conventions where one exists.
5. **A bounded, failure-isolated export pipeline.** Spans and log records are buffered (default 2 048 each); a full buffer drops the newest records and counts them (`holqa.telemetry.dropped`). Recording never calls an exporter: exports run in the background, one batch per signal at a time, each call with a time limit (default 10 seconds) whose expiry aborts the `signal` passed to the exporter. An exporter that rejects or times out loses that batch for itself only, and the failure is reported as a `warn` log with `HOLQA_TELEMETRY_EXPORT_FAILED` at most once per minute per exporter and signal. Timers are unreferenced, so telemetry never keeps a process alive. `runtime.stop` flushes within `telemetryMs`.
6. **Redaction before anything leaves the runtime.** Every log entry, span attribute, span event and span status message is redacted: values of fields whose normalized names contain `password`, `passwd`, `secret`, `privatekey` or `credential`, or end with `token`, `authorization`, `cookie`, `apikey`, `accesskey` or `signature` (so counters such as `tokenCount` stay readable), and every occurrence of a declared secret's value of at least four characters. Applications can add field names. Console output is not intercepted.
7. **Log export is opt-in.** Structured log entries always go to the runtime's log sink; they are also sent to exporters as OpenTelemetry log records only with `telemetry.exportLogs`, because the OpenTelemetry JavaScript logs signal is still under development.
8. **OTLP/HTTP with JSON, in an integration package.** `@holqa/opentelemetry` encodes OTLP/JSON and posts it with the Fetch API to any OTLP/HTTP receiver, and reads the standard `OTEL_*` environment variables. Settings it cannot honour, such as the `grpc` or `http/protobuf` protocols or an unknown sampler, are reported as `HOLQA_TELEMETRY_CONFIG_INVALID` rather than ignored. `@holqa/cli` may depend on it, so `holqa dev` and the operation commands export when `OTEL_EXPORTER_OTLP_ENDPOINT` is set. This amends ADR 0017's tools layer; in exchange `@holqa/opentelemetry` is pinned to depend on `@holqa/core` only, enforced by `scripts/check-boundaries.ts` ([package boundaries](../package-boundaries.md)).
9. **A local telemetry store and CLI-first inspection.** `@holqa/local` keeps recent spans, log entries and metric series in `telemetry.sqlite` in the state directory, separate from the resource state, with bounded retention. Resource state format 4 adds the `traceparent` column to deliveries. `holqa logs`, `holqa traces list`, `holqa traces inspect`, `holqa events inspect` and `holqa metrics` read it. A graphical dashboard is **Planned**.

The decision is implemented in `@holqa/core`, `@holqa/sdk`, `@holqa/runtime-bun`, `@holqa/local`, `@holqa/testing`, `@holqa/cli` and `@holqa/opentelemetry`, and exercised by `examples/observability`.

## Consequences

### Positive

- One request and everything it causes form one trace that any OTLP receiver (an OpenTelemetry Collector, or a backend that accepts OTLP directly) can display.
- Local development needs no account, collector or extra process: the CLI reads the local store.
- Safety controls do not depend on telemetry settings; telemetry can be disabled without changing behavior.
- A failing or slow backend costs at most bounded memory and one bounded request per export interval.

### Negative

- Holqa maintains its own small tracer, meter and OTLP encoder instead of reusing the OpenTelemetry SDK; features such as exemplars, delta temporality, exporter retries and OTLP over protobuf or gRPC are not available.
- There is no bridge to `@opentelemetry/api` yet, so spans that application code creates with the OpenTelemetry API do not join Holqa's traces automatically (**Planned**).
- Redaction only finds secrets it was told about, in the form it was told; transformed secrets (encoded, hashed, split) are not recognized.
- Metrics are cumulative per runtime instance; a dev reload starts new counters.
- Adding the required `debug` member to `InvocationLogger` breaks hand-written logger doubles at the type level.

### Revisit when

- The OpenTelemetry JavaScript logs signal becomes stable: consider exporting logs by default.
- Applications need spans created with the OpenTelemetry API inside handlers: add an API bridge.
- A production binding needs protobuf or gRPC transport.

## Alternatives considered

### Depend on the OpenTelemetry JavaScript SDK

It would provide exporters, processors and context propagation. It was deferred: it pulls several packages into the runtime, its logs signal is not stable, its context manager overlaps with the runtime's invocation tracker, and the core contracts must stay dependency-free. The data model is close enough that a bridge remains possible.

### One continuous parent-child trace for every message

Simpler to display, but contrary to OpenTelemetry's messaging conventions for batched or long-delayed processing. The default keeps one trace for the common case and always records the link; `messages: "link"` follows the conventions strictly.

### Reuse lineage identifiers as trace identifiers

Lineage roots are runtime-assigned and never sampled; trace identifiers may come from callers and are sampled. Merging them would let sampling or a caller influence safety controls.

### Store telemetry in the resource state database

Telemetry is high-volume and disposable; keeping it in a separate file lets it be pruned or deleted without touching queues, objects and schedules, and keeps the state format stable.

## Related

- [Observability](../../concepts/observability.md)
- [Observability guide](../../guides/observability.md)
- [Event safety](../../concepts/event-safety.md)
- [Runtime reference](../../reference/runtime.md)
- [CLI reference](../../reference/cli.md)
- [W3C Trace Context](https://www.w3.org/TR/trace-context/)
- [OpenTelemetry Protocol specification](https://opentelemetry.io/docs/specs/otlp/)
