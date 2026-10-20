# Observability guide

> **Status:** **Implemented** in the private, unpublished packages; every command and API on this page runs today. The local development dashboard of `holqa dev` is described in the [local development guide](local-development.md); a graphical trace timeline view is **Planned**. The examples come from [`examples/observability`](../../examples/observability/README.md).

This guide shows how to read the logs, traces and metrics of a Holqa application locally, how to send them to an OpenTelemetry-compatible backend, how to configure telemetry when you run the runtime yourself, and how to assert on telemetry in tests. The concepts are in [observability](../concepts/observability.md).

## Inspect executions locally

`holqa dev` and the operation commands that run handlers (`holqa invoke`, `holqa cron run`) record spans, log entries and metrics in the local telemetry store of the state directory (`.holqa/local/telemetry.sqlite` by default). The telemetry commands read it, also while a dev session runs.

Run a handler once:

```bash
cd examples/observability
export PAYMENT_TOKEN=pay-tok-7f3a9c
holqa invoke orders.charge --input '{"orderId":"o-9","amountCents":500}' --app app/infra.ts
```

List the recorded traces:

```bash
holqa traces list --app app/infra.ts
```

For the command above, the output was:

```text
TRACE                             START (UTC)               DURATION  SPANS  ERRORS  NAME
e97be32659c3a96302149ff56d863bfe  2026-10-20 07:29:21.248       3 ms      2       0  invoke orders.charge
```

Print one trace as a tree with a timeline. An unambiguous prefix of the trace identifier is enough:

```bash
holqa traces inspect e97be326 --app app/infra.ts
```

```text
trace e97be32659c3a96302149ff56d863bfe  2 spans  3 ms
invoke orders.charge       internal  +  0.0 ms  |################################|      3 ms  ok
`- put receipts            client    +    1 ms  |            ##########          |    0.8 ms  ok
```

Failed spans show their error type and exception message; spans linked from other traces are listed under the span.

Print log entries. The secret token and the `authorization` field are redacted, and `otel` shows the start of the trace identifier:

```bash
holqa logs --handler orders.charge --app app/infra.ts
```

```text
07:29:21.249  info   orders.charge         charging with token [REDACTED]  queue.message orders  attempt 1  trace 34bd8302  otel e97be326  orderId=o-9 authorization=[REDACTED]
07:29:21.250  info   orders.charge         invocation completed  3 ms  queue.message orders  trace 34bd8302  otel e97be326  -> wrote receipts/receipts/o-9.json
```

`holqa logs --follow` keeps printing new entries until you press Ctrl+C. Filter with `--handler <id>`, `--trace <trace-id>`, `--level <debug|info|warn|error>` (that level and more severe) and `--limit <n>`; `--json` prints one JSON entry per line.

Print the framework metrics:

```bash
holqa metrics --app app/infra.ts
```

```text
holqa.handler.duration (histogram, s)
  holqa.handler.id=orders.charge holqa.outcome=ok holqa.trigger.kind=queue.message  count 1  avg 3 ms  p50 <= 3 ms  p95 <= 3 ms  max 3 ms
holqa.handler.invocations (counter, {invocation})
  holqa.handler.id=orders.charge holqa.outcome=ok holqa.trigger.kind=queue.message  1
holqa.invocations.active (gauge, {invocation})
  holqa.invocation.state=running  0
  holqa.invocation.state=waiting  0
```

Histogram quantiles are upper bucket bounds, not exact values. A dev session also reports queue backlogs, HTTP durations and reload failures.

Inspect one queue message or object event: its delivery state, attempts, last error and lineage from the local state, the invocations that processed it, their log entries and its spans:

```bash
holqa events inspect <message-or-event-id> --app app/infra.ts
```

Message identifiers are printed by `holqa queue send` and listed by `holqa state`. An identifier that is neither in the local state nor in the telemetry store fails with `HOLQA_TELEMETRY_NOT_FOUND`.

## Export to an OpenTelemetry Collector or another OTLP backend

The CLI reads the standard OpenTelemetry environment variables. Set an endpoint and `holqa dev`, `holqa invoke` and `holqa cron run` export spans and metrics over OTLP/HTTP with JSON, in addition to the local store:

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
export OTEL_SERVICE_NAME=shop
holqa dev --app app/infra.ts
```

Any OTLP/HTTP receiver works: an OpenTelemetry Collector, which can forward to Jaeger, Grafana-based stacks or other backends, or a backend that accepts OTLP directly.

| Variable | Effect |
| --- | --- |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Base URL; signals go to `/v1/traces`, `/v1/metrics` and `/v1/logs`. Without any endpoint variable nothing is exported. |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, `..._METRICS_ENDPOINT`, `..._LOGS_ENDPOINT` | Complete URL of one signal. Without a base endpoint, only signals with their own endpoint are sent. |
| `OTEL_EXPORTER_OTLP_HEADERS`, `..._TRACES_HEADERS` and the other per-signal forms | `key=value,key=value` (percent-encoded) headers, for example authorization. Shared headers go to every signal; a signal's own headers only to that signal. Names and values HTTP does not allow are rejected. Values never appear in diagnostics. |
| `OTEL_EXPORTER_OTLP_TIMEOUT` | Time limit per request, in milliseconds (default 10 000), for every signal. Per-signal `..._TIMEOUT` variables are rejected. |
| `OTEL_EXPORTER_OTLP_PROTOCOL` and the per-signal forms | Must be `http/json` when set; `grpc` and `http/protobuf` are rejected. |
| `OTEL_EXPORTER_OTLP_COMPRESSION`, `..._CERTIFICATE`, `..._CLIENT_KEY`, `..._CLIENT_CERTIFICATE` and the per-signal forms | Compression must be `none`; certificate settings are rejected, because the Fetch API cannot load them. |
| `OTEL_PROPAGATORS` | Must be `tracecontext` when set. |
| `OTEL_TRACES_EXPORTER`, `OTEL_METRICS_EXPORTER`, `OTEL_LOGS_EXPORTER` | `otlp` or `none`. Traces and metrics are on by default; logs only with `OTEL_LOGS_EXPORTER=otlp`. |
| `OTEL_SERVICE_NAME`, `OTEL_RESOURCE_ATTRIBUTES` | Resource attributes; the service name defaults to the application's name. |
| `OTEL_TRACES_SAMPLER`, `OTEL_TRACES_SAMPLER_ARG` | `parentbased_always_on`, `parentbased_always_off` or `parentbased_traceidratio` (with a ratio from 0 to 1). Holqa always follows a caller's sampling decision, so `always_on`, `always_off` and `traceidratio` are rejected. |
| `OTEL_SDK_DISABLED=true` | Turns OTLP export off. |

Unsupported values fail the application process with `HOLQA_TELEMETRY_CONFIG_INVALID` instead of being ignored. Exporter settings (protocol, compression, certificates, headers, time limit, propagators, endpoint URLs) are only checked when an endpoint is configured, so variables set for other tools do not matter otherwise. An unreachable receiver does not affect the application: each failed batch is dropped and reported at most once a minute as a `warn` entry with `HOLQA_TELEMETRY_EXPORT_FAILED`.

## Configure telemetry in your own runtime

When you call `createRuntime` yourself, pass exporters and settings:

```ts
import { createOtlpHttpExporter, readOtelEnvironment } from "@holqa/opentelemetry";
import { createRuntime } from "@holqa/runtime-bun";

const runtime = createRuntime({
  app,
  handlers,
  logLevel: "info",
  redact: { keys: ["ssn"] },
  telemetry: {
    exporters: [createOtlpHttpExporter({ endpoint: "http://localhost:4318" })],
    sampleRatio: 0.25,
    messages: "parent",
    resource: { "deployment.environment.name": "staging" }
  }
});
```

`readOtelEnvironment(process.env)` returns the same settings the CLI uses, as a `Result`, so a service can honour the `OTEL_*` variables. `runtime.telemetry.flush()` exports everything recorded so far; `runtime.stop({ telemetryMs })` flushes before it returns. See the [runtime reference](../reference/runtime.md#telemetry) for every option.

To keep the local inspection commands working for a runtime you start yourself, add the local store's exporter and log sink:

```ts
import { createLocalTelemetryStore } from "@holqa/local";

const store = createLocalTelemetryStore({ directory: ".holqa/local" });
const runtime = createRuntime({ app, handlers, binding: env.binding, log: store.writeLog, telemetry: { exporters: [store.exporter] } });
```

## Select the telemetry destination in a binding configuration

`otlp.telemetry(options)` from `@holqa/opentelemetry` is a telemetry service provider, so the destination is chosen per environment, independently of compute and resources:

```ts
import { defineBindings } from "@holqa/bindings";
import { credentialRef } from "@holqa/core";
import { otlp } from "@holqa/opentelemetry";

export default defineBindings(app, {
  name: "staging",
  defaults: platformProvider, // a platform provider
  services: { telemetry: otlp.telemetry({ endpoint: "http://collector:4318", headers: { authorization: credentialRef("OTLP_AUTHORIZATION") } }) }
});
```

| Option | Default | Meaning |
| --- | --- | --- |
| `endpoint` | required | The OTLP/HTTP receiver's base URL. URLs with credentials are rejected. |
| `headers` | none | Header values as credential references, resolved when the binding starts and never logged. |
| `signals` | all | `{ traces, metrics, logs }`; log records are handed over only when the runtime's `telemetry.exportLogs` is set. |
| `timeoutMs` | `10000` | The time limit of one export request. |
| `name` | `otlp` | The provider's name. |

Exports run in the runtime's bounded background pipeline: a receiver that is down loses only the affected batches and never fails an invocation. The binding manifest lists the receiver as a connector and the header references as credentials.

## Propagate the trace to outgoing calls

Handler and middleware arguments include `telemetry` when telemetry is recorded. Pass its `traceparent` to services you call, so their spans join the trace:

```ts
export const chargeOrder = resources.orders.consume({
  id: "orders.charge",
  handler: async ({ message, telemetry }) => {
    await fetch("https://payments.example/charges", {
      method: "POST",
      headers: telemetry === undefined ? {} : { traceparent: telemetry.traceparent },
      body: JSON.stringify({ orderId: message.orderId })
    });
  }
});
```

## Test telemetry

`createTestApp` always records telemetry in memory with deterministic identifiers. Flush it, then assert on spans, metrics and exported log records:

```ts
import { createTestApp, spanTree } from "@holqa/testing";

const shop = await createTestApp({ app, handlers, env: { PAYMENT_TOKEN: "pay-tok-7f3a9c" } });
await shop.fetch("/api/orders", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ orderId: "o-1", amountCents: 1250 }) });
await shop.drain();
await shop.flushTelemetry();

const [server] = shop.telemetry.spans({ kind: "server" });
expect(spanTree(shop.telemetry.trace(server!.traceId))).toEqual([
  { name: "POST /api/orders", kind: "server", status: "ok", children: [
    { name: "send orders", kind: "producer", status: "ok", children: [
      { name: "process orders", kind: "consumer", status: "ok", children: [
        { name: "put receipts", kind: "client", status: "ok", children: [
          { name: "process receipts", kind: "consumer", status: "ok", children: [] }
        ] }
      ] }
    ] }
  ] }
]);
expect(shop.telemetry.metric("holqa.handler.invocations", { "holqa.outcome": "ok" })).toBe(3);
```

`createTestApp({ telemetry: { exporters } })` adds exporters, and `telemetry: { exportLogs: true }` records log records too. Outside `createTestApp`, `createMemoryTelemetry()` returns an exporter to pass to `createRuntime` and the same query functions. The test helpers are listed in the [`@holqa/testing` README](../../packages/testing/README.md).

## Related

- [Observability](../concepts/observability.md)
- [CLI reference](../reference/cli.md#telemetry-commands)
- [`@holqa/opentelemetry`](../../packages/integrations/opentelemetry/README.md)
- [ADR 0027](../architecture/decisions/0027-observability-telemetry-and-local-inspection.md)
