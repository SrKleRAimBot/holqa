import type {
  ProviderContext,
  SpanRecord
} from "@holqa/core";

import {
  credentialRef,
  diagnosticsOf,
  validateProvider
} from "@holqa/core";

import {
  describe,
  expect,
  it
} from "bun:test";

import { otlp } from "@/provider";

/** One exported span. */
const span: SpanRecord = { traceId: "0af7651916cd43dd8448eb211c80319c", spanId: "b7ad6b7169203331", name: "GET /", kind: "server", startTime: 1, endTime: 2, status: { code: "unset" }, attributes: {}, events: [], links: [] };

describe("otlp.telemetry", () => {
  it("is a telemetry service provider whose header values are credential references", () => {
    const provider = otlp.telemetry({ endpoint: "http://collector:4318", headers: { authorization: credentialRef("OTLP_AUTHORIZATION") } });
    expect(validateProvider(provider)).toEqual([]);
    expect([provider.role, provider.services, provider.contracts]).toEqual(["service", { telemetry: true }, { telemetry: 1 }]);
    expect(provider.settings).toEqual({ endpoint: "http://collector:4318", headers: ["authorization"], signals: { traces: true, metrics: true, logs: true } });
    expect(provider.credentials?.map(reference => reference.name)).toEqual(["OTLP_AUTHORIZATION"]);
    expect(provider.topology?.connectors).toEqual(["an OTLP/HTTP receiver at http://collector:4318"]);
  });

  it("exports through an exporter that sends the resolved headers", async () => {
    const requests: Array<{ readonly url: string; readonly authorization: string | null }> = [];
    const provider = otlp.telemetry({
      endpoint: "http://collector:4318",
      headers: { authorization: credentialRef("OTLP_AUTHORIZATION") },
      fetch: async (url, init) => {
        requests.push({ url, authorization: new Headers(init.headers).get("authorization") });
        return new Response(null, { status: 200 });
      }
    });
    const instance = await provider.open({ credential: reference => reference.name === "OTLP_AUTHORIZATION" ? "Bearer token" : "" } as ProviderContext);
    await instance.telemetry![0]!.exportSpans!([span], { attributes: { "service.name": "shop" } });
    expect(requests).toEqual([{ url: "http://collector:4318/v1/traces", authorization: "Bearer token" }]);
  });

  it("rejects endpoints with credentials and plain header values", () => {
    let codes: string[] = [];
    try {
      otlp.telemetry({ endpoint: "http://user:pass@collector:4318", headers: { authorization: "Bearer token" as never } });
    } catch (error) {
      codes = diagnosticsOf(error).map(diagnostic => diagnostic.code);
    }
    expect(codes).toEqual(["HOLQA_BINDING_CONFIG_INVALID", "HOLQA_BINDING_CONFIG_INVALID"]);
  });
});