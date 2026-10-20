/** One OTLP/HTTP request a {@link FakeCollector} received. */
export interface CollectedRequest {
  readonly path: string;
  readonly body: unknown;
}

/** A local OTLP/HTTP receiver that records what it receives, standing in for an OpenTelemetry Collector. */
export interface FakeCollector {
  /** Its base URL, for `OTEL_EXPORTER_OTLP_ENDPOINT` or `createOtlpHttpExporter({ endpoint })`. */
  readonly url: string;
  readonly requests: CollectedRequest[];
  /** The spans of every received trace request, flattened. */
  readonly spans: () => Array<{ readonly traceId: string; readonly spanId: string; readonly parentSpanId?: string; readonly name: string; readonly kind: number; readonly attributes: ReadonlyArray<{ readonly key: string; readonly value: Record<string, unknown> }> }>;
  /** The names of every received metric. */
  readonly metricNames: () => string[];
  readonly stop: () => Promise<void>;
}

/**
 * Starts a fake OTLP/HTTP receiver on a free local port. It accepts JSON on
 * `/v1/traces`, `/v1/metrics` and `/v1/logs`, as an OpenTelemetry Collector's
 * OTLP/HTTP receiver does, and answers like one.
 *
 * @returns The running receiver.
 */
export function startCollector(): FakeCollector {
  const requests: CollectedRequest[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const path = new URL(request.url).pathname;
      if (request.method !== "POST" || !["/v1/traces", "/v1/metrics", "/v1/logs"].includes(path) || request.headers.get("content-type") !== "application/json")
        return new Response("unsupported", { status: 415 });
      requests.push({ path, body: await request.json() });
      return Response.json({ partialSuccess: {} });
    }
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    requests,
    spans: () => requests.filter(request => request.path === "/v1/traces").flatMap(request => (request.body as { resourceSpans: Array<{ scopeSpans: Array<{ spans: [] }> }> }).resourceSpans.flatMap(resource => resource.scopeSpans.flatMap(scope => scope.spans))),
    metricNames: () => [...new Set(requests.filter(request => request.path === "/v1/metrics").flatMap(request => (request.body as { resourceMetrics: Array<{ scopeMetrics: Array<{ metrics: Array<{ name: string }> }> }> }).resourceMetrics.flatMap(resource => resource.scopeMetrics.flatMap(scope => scope.metrics.map(metric => metric.name)))))].sort(),
    stop: async () => {
      await server.stop(true);
    }
  };
}