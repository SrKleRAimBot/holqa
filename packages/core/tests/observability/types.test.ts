import type {
  InvocationContext,
  InvocationTelemetry,
  MetricRecord,
  SpanStatus,
  TelemetryExporter
} from "@/index";

import {
  describe,
  expectTypeOf,
  it
} from "bun:test";

import { frameworkMetrics } from "@/observability/framework-metrics";

describe("observability types", () => {
  it("offers the telemetry context as an optional, exact member of the invocation context", () => {
    expectTypeOf<InvocationContext["telemetry"]>().toEqualTypeOf<InvocationTelemetry | undefined>();
    // @ts-expect-error -- with exactOptionalPropertyTypes, an absent context is omitted, never undefined.
    const context: Pick<InvocationContext, "telemetry"> = { telemetry: undefined };
    expectTypeOf(context).toBeObject();
  });

  it("narrows metric records by type", () => {
    /**
     * Reads the first point's count or value, which only narrowing by `type` allows.
     *
     * @param record - A metric record.
     * @returns The count of a histogram point, the value otherwise.
     */
    function firstValue(record: MetricRecord): number {
      return record.type === "histogram" ? record.points[0]?.count ?? 0 : record.points[0]?.value ?? 0;
    }
    expectTypeOf(firstValue).returns.toBeNumber();
  });

  it("allows a status message only on errors", () => {
    expectTypeOf<{ code: "error"; message: "boom" }>().toMatchTypeOf<SpanStatus>();
    // @ts-expect-error -- a message describes an error only.
    const unset: SpanStatus = { code: "ok", message: "fine" };
    expectTypeOf(unset).toBeObject();
  });

  it("keeps framework metric names literal", () => {
    expectTypeOf(frameworkMetrics.handlerInvocations.name).toEqualTypeOf<"holqa.handler.invocations">();
  });

  it("lets an exporter implement only the signals it handles", () => {
    expectTypeOf<{ name: "spans-only"; exportSpans: () => Promise<void> }>().toMatchTypeOf<TelemetryExporter>();
  });
});