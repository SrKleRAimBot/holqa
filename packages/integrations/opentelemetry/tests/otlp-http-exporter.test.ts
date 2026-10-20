import type { SpanRecord } from "@holqa/core";

import {
  afterEach,
  describe,
  expect,
  it
} from "bun:test";

import { createOtlpHttpExporter } from "@/otlp-http-exporter";

/** One received request. */
interface Received {
  readonly path: string;
  readonly contentType: string | null;
  readonly authorization: string | null;
  readonly body: unknown;
}

/** Servers to stop after each test. */
const servers: Array<{ readonly stop: (force?: boolean) => Promise<void> | void }> = [];

afterEach(async () => {
  for (const server of servers.splice(0))
    await server.stop(true);
});

/**
 * Starts a fake OTLP/HTTP receiver on a free local port.
 *
 * @param status - The status it answers with.
 * @returns Its base URL and what it received.
 */
function receiver(status = 200): { readonly url: string; readonly received: Received[] } {
  const received: Received[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      received.push({ path: new URL(request.url).pathname, contentType: request.headers.get("content-type"), authorization: request.headers.get("authorization"), body: await request.json() });
      return Response.json({}, { status });
    }
  });
  servers.push(server);
  return { url: `http://127.0.0.1:${server.port}`, received };
}

/** A finished span. */
const span: SpanRecord = { traceId: "0af7651916cd43dd8448eb211c80319c", spanId: "b7ad6b7169203331", name: "GET /", kind: "server", startTime: 1, endTime: 2, status: { code: "unset" }, attributes: {}, events: [], links: [] };

/** The resource every test exports. */
const resource = { attributes: { "service.name": "shop" } };

describe("createOtlpHttpExporter", () => {
  it("posts each signal as OTLP/JSON to its path below the endpoint, with the configured headers", async () => {
    const { url, received } = receiver();
    const exporter = createOtlpHttpExporter({ endpoint: `${url}/`, headers: { authorization: "Bearer s3cret" } });
    await exporter.exportSpans!([span], resource);
    await exporter.exportMetrics!([{ type: "gauge", name: "g", description: "", unit: "1", points: [{ attributes: {}, time: 1, value: 1 }] }], resource);
    await exporter.exportLogs!([{ time: 1, severity: "info", body: "hi", attributes: {} }], resource);
    expect(received.map(request => request.path)).toEqual(["/v1/traces", "/v1/metrics", "/v1/logs"]);
    expect(received.every(request => request.contentType === "application/json" && request.authorization === "Bearer s3cret")).toBe(true);
    expect(received[0]!.body).toMatchObject({ resourceSpans: [{ scopeSpans: [{ spans: [{ traceId: span.traceId, kind: 2 }] }] }] });
  });

  it("rejects when the receiver answers with an error, without revealing credentials", async () => {
    const { url } = receiver(503);
    const exporter = createOtlpHttpExporter({ tracesEndpoint: `${url.replace("http://", "http://user:pw@")}/custom?token=abc`, signals: { metrics: false, logs: false } });
    await expect(exporter.exportSpans!([span], resource)).rejects.toThrow(`OTLP export to ${url}/custom was rejected with HTTP 503.`);
    expect(exporter.exportMetrics).toBeUndefined();
  });

  it("rejects when the receiver is unreachable or too slow", async () => {
    const unreachable = createOtlpHttpExporter({ endpoint: "http://127.0.0.1:9", timeoutMs: 1_000 });
    await expect(unreachable.exportSpans!([span], resource)).rejects.toThrow("OTLP export to http://127.0.0.1:9/v1/traces failed");
    const slow = createOtlpHttpExporter({ endpoint: "http://collector.test", timeoutMs: 10, fetch: (_input, init) => new Promise((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(init.signal?.reason))) });
    await expect(slow.exportSpans!([span], resource)).rejects.toThrow("no answer within 10 ms");
  });

  it("rejects invalid settings with a diagnostic", () => {
    expect(() => createOtlpHttpExporter({ endpoint: "collector:4318" })).toThrow(expect.objectContaining({ code: "HOLQA_TELEMETRY_CONFIG_INVALID" }));
    expect(() => createOtlpHttpExporter({ timeoutMs: 0 })).toThrow(expect.objectContaining({ code: "HOLQA_TELEMETRY_CONFIG_INVALID" }));
  });
});