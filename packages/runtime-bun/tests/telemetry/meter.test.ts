import type { FrameworkMetric } from "@holqa/core";

import { frameworkMetrics } from "@holqa/core";
import {
  describe,
  expect,
  it
} from "bun:test";

import { Meter } from "@/telemetry/meter";

/** A counter with one allowed attribute. */
const counter: FrameworkMetric = { name: "test.count", type: "counter", unit: "1", description: "Counts.", attributes: ["kind"] };

describe("Meter", () => {
  it("keeps only allowed attributes, so identifiers never become series", async () => {
    const meter = new Meter({ maxSeries: 10, wallNow: () => 5 });
    meter.add(counter, 1, { kind: "a", messageId: "m-1" });
    meter.add(counter, 2, { kind: "a", messageId: "m-2" });
    const [record] = await meter.collect();
    expect(record).toMatchObject({ name: "test.count", type: "sum", monotonic: true, points: [{ attributes: { kind: "a" }, value: 3, startTime: 5, time: 5 }] });
  });

  it("aggregates series beyond the limit into one overflow series", async () => {
    const meter = new Meter({ maxSeries: 2, wallNow: () => 0 });
    for (const kind of ["a", "b", "c", "d"])
      meter.add(counter, 1, { kind });
    const [record] = await meter.collect();
    expect(record!.points.map(point => [point.attributes, (point as { value: number }).value])).toEqual([[{ kind: "a" }, 1], [{ kind: "b" }, 1], [{ "otel.metric.overflow": true }, 2]]);
  });

  it("counts histogram values into explicit buckets", async () => {
    const meter = new Meter({ maxSeries: 10, wallNow: () => 0 });
    for (const value of [0.001, 0.2, 20])
      meter.record(frameworkMetrics.handlerDuration, value, { "holqa.handler.id": "h" }, [0.1, 1]);
    const [record] = await meter.collect();
    expect(record).toMatchObject({ type: "histogram", points: [{ count: 3, min: 0.001, max: 20, bounds: [0.1, 1], bucketCounts: [1, 1, 1] }] });
  });

  it("observes gauges at collection and skips a gauge whose callback fails", async () => {
    const meter = new Meter({ maxSeries: 10, wallNow: () => 0 });
    meter.gauge(frameworkMetrics.queuePending, () => [{ value: 4, attributes: { "messaging.destination.name": "orders" } }]);
    meter.gauge(frameworkMetrics.activeInvocations, () => {
      throw new Error("closed");
    });
    expect(await meter.collect()).toEqual([{ type: "gauge", name: "holqa.queue.pending", description: frameworkMetrics.queuePending.description, unit: "{message}", points: [{ attributes: { "messaging.destination.name": "orders" }, time: 0, value: 4 }] }]);
  });
});