/** Whether a framework metric is a counter, a histogram or a gauge. */
export type FrameworkMetricType = "counter" | "histogram" | "gauge";

/**
 * One metric every Holqa runtime reports: its name, type, unit and the only
 * attributes it may carry. The attribute list is closed and holds no
 * high-cardinality values (no user, message, invocation or object
 * identifiers, no object keys, no payload fields), so the number of series
 * stays bounded by the application's shape.
 */
export interface FrameworkMetric {
  readonly name: string;
  readonly type: FrameworkMetricType;
  /** A UCUM unit. Durations are in seconds, as OpenTelemetry semantic conventions require. */
  readonly unit: string;
  readonly description: string;
  /** The attribute keys the metric may carry; anything else is dropped before aggregation. */
  readonly attributes: readonly string[];
}

/**
 * The framework metrics, by role. Names follow OpenTelemetry semantic
 * conventions where one exists (`http.server.request.duration`,
 * `messaging.process.duration`) and use the `holqa.` prefix otherwise.
 * Names are a public contract: tools and dashboards match on them.
 */
export const frameworkMetrics = Object.freeze({
  handlerInvocations: Object.freeze({ name: "holqa.handler.invocations", type: "counter" as const, unit: "{invocation}", description: "Handler invocations, by handler, trigger kind and outcome.", attributes: Object.freeze(["holqa.handler.id", "holqa.trigger.kind", "holqa.outcome"] as const) }),
  handlerDuration: Object.freeze({ name: "holqa.handler.duration", type: "histogram" as const, unit: "s", description: "Handler invocation duration, including time spent waiting for a concurrency slot.", attributes: Object.freeze(["holqa.handler.id", "holqa.trigger.kind", "holqa.outcome"] as const) }),
  handlerFailures: Object.freeze({ name: "holqa.handler.failures", type: "counter" as const, unit: "{invocation}", description: "Failed handler invocations, by handler and error category (a diagnostic code).", attributes: Object.freeze(["holqa.handler.id", "holqa.trigger.kind", "error.type"] as const) }),
  activeInvocations: Object.freeze({ name: "holqa.invocations.active", type: "gauge" as const, unit: "{invocation}", description: "Handler executions running, including orphans, and invocations waiting for a slot.", attributes: Object.freeze(["holqa.invocation.state"] as const) }),
  queuePending: Object.freeze({ name: "holqa.queue.pending", type: "gauge" as const, unit: "{message}", description: "Messages waiting in a queue (ready, delayed or in flight), where the binding reports it.", attributes: Object.freeze(["messaging.destination.name"] as const) }),
  processingDuration: Object.freeze({ name: "messaging.process.duration", type: "histogram" as const, unit: "s", description: "How long processing one queue message or object event took, by destination and outcome.", attributes: Object.freeze(["messaging.destination.name", "messaging.operation.name", "holqa.outcome"] as const) }),
  deliveryRetries: Object.freeze({ name: "holqa.delivery.retries", type: "counter" as const, unit: "{delivery}", description: "Deliveries released for another attempt after a failure.", attributes: Object.freeze(["holqa.handler.id", "messaging.destination.name"] as const) }),
  deliveryDeadLetters: Object.freeze({ name: "holqa.delivery.dead_letters", type: "counter" as const, unit: "{delivery}", description: "Deliveries dead-lettered or discarded without another attempt.", attributes: Object.freeze(["holqa.handler.id", "messaging.destination.name", "holqa.settlement"] as const) }),
  eventsBlocked: Object.freeze({ name: "holqa.events.blocked", type: "counter" as const, unit: "{event}", description: "Events refused by an event guard (depth, publication limit, age or operation budget), by code.", attributes: Object.freeze(["holqa.handler.id", "error.type"] as const) }),
  httpServerDuration: Object.freeze({ name: "http.server.request.duration", type: "histogram" as const, unit: "s", description: "Duration of HTTP requests served by routes and procedures, by method, route template and status.", attributes: Object.freeze(["http.request.method", "http.route", "http.response.status_code"] as const) }),
  reloadFailures: Object.freeze({ name: "holqa.dev.reload.failures", type: "counter" as const, unit: "{reload}", description: "Development reloads that failed to analyze, build or start; the previous generation kept serving.", attributes: Object.freeze(["holqa.reload.stage"] as const) }),
  telemetryDropped: Object.freeze({ name: "holqa.telemetry.dropped", type: "counter" as const, unit: "{record}", description: "Spans and log records dropped because the export buffer was full or an export failed.", attributes: Object.freeze(["holqa.telemetry.signal", "holqa.telemetry.reason"] as const) })
} as const) satisfies Readonly<Record<string, FrameworkMetric>>;

/** The attribute a metric point carries when its metric reached its series limit; its values are aggregated there. */
export const metricOverflowAttribute = "otel.metric.overflow";