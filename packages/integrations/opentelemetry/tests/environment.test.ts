import {
  describe,
  expect,
  it
} from "bun:test";

import { readOtelEnvironment } from "@/environment";

describe("readOtelEnvironment", () => {
  it("configures nothing without an endpoint", () => {
    expect(readOtelEnvironment({})).toEqual({ ok: true, value: {} });
    expect(readOtelEnvironment({ OTEL_SERVICE_NAME: "shop" })).toEqual({ ok: true, value: { serviceName: "shop" } });
  });

  it("reads the endpoint, headers, time limit, resource and sampler", () => {
    expect(readOtelEnvironment({
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318",
      OTEL_EXPORTER_OTLP_HEADERS: "authorization=Bearer%20abc,x-tenant=t1",
      OTEL_EXPORTER_OTLP_TIMEOUT: "2000",
      OTEL_RESOURCE_ATTRIBUTES: "deployment.environment.name=dev",
      OTEL_TRACES_SAMPLER: "parentbased_traceidratio",
      OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
      OTEL_TRACES_SAMPLER_ARG: "0.25"
    })).toEqual({
      ok: true,
      value: {
        exporter: { endpoint: "http://collector:4318", headers: { "authorization": "Bearer abc", "x-tenant": "t1" }, timeoutMs: 2_000, signals: { traces: true, metrics: true, logs: false } },
        resource: { "deployment.environment.name": "dev" },
        sampleRatio: 0.25
      }
    });
  });

  it("sends only the signals that have an endpoint when no base endpoint is set, and honours exporter selection", () => {
    const result = readOtelEnvironment({ OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://traces.collector:4318/v1/traces", OTEL_LOGS_EXPORTER: "otlp" });
    expect(result).toEqual({ ok: true, value: { exporter: { tracesEndpoint: "http://traces.collector:4318/v1/traces", signals: { traces: true, metrics: false, logs: false } } } });
    expect(readOtelEnvironment({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://c:4318", OTEL_LOGS_EXPORTER: "otlp", OTEL_METRICS_EXPORTER: "none" })).toEqual({ ok: true, value: { exporter: { endpoint: "http://c:4318", signals: { traces: true, metrics: false, logs: true } }, exportLogs: true } });
  });

  it("ignores exporter settings for other tools when no endpoint is configured", () => {
    expect(readOtelEnvironment({ OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf", OTEL_EXPORTER_OTLP_COMPRESSION: "gzip" })).toEqual({ ok: true, value: {} });
  });

  it("sends a signal's own headers only with that signal", () => {
    expect(readOtelEnvironment({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://c:4318", OTEL_EXPORTER_OTLP_TRACES_HEADERS: "x-key=t" })).toEqual({ ok: true, value: { exporter: { endpoint: "http://c:4318", tracesHeaders: { "x-key": "t" }, signals: { traces: true, metrics: true, logs: false } } } });
  });

  it.each([
    ["a non-parent-based sampler", { OTEL_TRACES_SAMPLER: "traceidratio" }],
    ["compression", { OTEL_EXPORTER_OTLP_ENDPOINT: "http://c:4318", OTEL_EXPORTER_OTLP_COMPRESSION: "gzip" }],
    ["client certificates", { OTEL_EXPORTER_OTLP_ENDPOINT: "http://c:4318", OTEL_EXPORTER_OTLP_CLIENT_KEY: "/k.pem" }],
    ["per-signal time limits", { OTEL_EXPORTER_OTLP_ENDPOINT: "http://c:4318", OTEL_EXPORTER_OTLP_TRACES_TIMEOUT: "100" }],
    ["other propagators", { OTEL_EXPORTER_OTLP_ENDPOINT: "http://c:4318", OTEL_PROPAGATORS: "tracecontext,baggage" }],
    ["an invalid header", { OTEL_EXPORTER_OTLP_ENDPOINT: "http://c:4318", OTEL_EXPORTER_OTLP_HEADERS: "bad name=v" }],
    ["an invalid endpoint", { OTEL_EXPORTER_OTLP_ENDPOINT: "collector:4318" }],
    ["an unsupported exporter", { OTEL_TRACES_EXPORTER: "zipkin" }]
  ])("rejects %s explicitly", (_name, env) => {
    const result = readOtelEnvironment(env);
    expect(result.ok).toBe(false);
    expect(result.ok ? [] : result.error.map(diagnostic => diagnostic.code)).toEqual(["HOLQA_TELEMETRY_CONFIG_INVALID"]);
  });

  it("keeps __proto__ an ordinary resource attribute", () => {
    const result = readOtelEnvironment({ OTEL_RESOURCE_ATTRIBUTES: "__proto__=x" });
    expect(result.ok && Object.getPrototypeOf(result.value.resource)).toBe(null);
  });

  it("is switched off by OTEL_SDK_DISABLED", () => {
    expect(readOtelEnvironment({ OTEL_SDK_DISABLED: "true", OTEL_EXPORTER_OTLP_ENDPOINT: "http://c:4318" })).toEqual({ ok: true, value: {} });
  });

  it("reports settings it cannot honour without echoing header values", () => {
    const result = readOtelEnvironment({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://c:4318", OTEL_EXPORTER_OTLP_PROTOCOL: "grpc", OTEL_TRACES_SAMPLER: "jaeger_remote", OTEL_EXPORTER_OTLP_HEADERS: "s3cr3t-without-equals" });
    expect(result.ok).toBe(false);
    const messages = result.ok ? [] : result.error.map(diagnostic => diagnostic.message);
    expect(messages).toHaveLength(3);
    expect(result.ok ? [] : result.error.map(diagnostic => diagnostic.code)).toEqual(["HOLQA_TELEMETRY_CONFIG_INVALID", "HOLQA_TELEMETRY_CONFIG_INVALID", "HOLQA_TELEMETRY_CONFIG_INVALID"]);
    expect(JSON.stringify(messages)).not.toContain("s3cr3t");
  });
});