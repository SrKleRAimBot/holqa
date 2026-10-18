import type {
  ScheduleContext,
  ScheduleHandler
} from "@/index";

import {
  getHandlerDescriptor,
  getResourceDescriptor
} from "@holqa/core";
import {
  createContext,
  thrownCodes
} from "@test/support/test-binding";
import {
  describe,
  expect,
  expectTypeOf,
  it
} from "bun:test";

import { schedule } from "@/index";

describe("schedule", () => {
  it("normalizes the cron expression and records the overlap requirement", () => {
    const nightly = schedule({ id: "nightly", cron: " 0  3 * * * ", timezone: "Europe/Berlin", overlap: "skip" });
    expect<unknown>(getResourceDescriptor(nightly)).toMatchObject({
      kind: "schedule",
      config: { cron: "0 3 * * *", timezone: "Europe/Berlin" },
      requirements: { overlap: "skip" }
    });
  });

  it("rejects malformed schedules", () => {
    /** Holds deliberate type errors checked by tsc; never executed. */
    const neverCalled = (): void => {
      // @ts-expect-error -- "queue" is not an overlap policy.
      schedule({ id: "bad", cron: "* * * * *", timezone: "UTC", overlap: "queue" });
      // @ts-expect-error -- `timezone` is required.
      schedule({ id: "bad", cron: "* * * * *", overlap: "skip" });
    };
    expect(typeof neverCalled).toBe("function");
    expect(thrownCodes(() => schedule({ id: "bad", cron: "* * *", timezone: " ", overlap: "queue" } as never))).toEqual([
      "HOLQA_DECLARATION_INVALID",
      "HOLQA_DECLARATION_INVALID",
      "HOLQA_DECLARATION_INVALID"
    ]);
  });

  it("passes the scheduled time to its handler", async () => {
    const hourly = schedule({ id: "hourly", cron: "0 * * * *", timezone: "UTC", overlap: "allow" });
    const runs: string[] = [];
    const handler = hourly.handle({ id: "hourly.report", handler: ({ scheduledTime }) => {
      runs.push(scheduledTime);
    } });
    expectTypeOf(handler).toEqualTypeOf<ScheduleHandler<"hourly", "hourly.report">>();
    expect<unknown>(getHandlerDescriptor(handler)?.definition.trigger).toEqual({ kind: "schedule.tick", resource: { kind: "schedule", id: "hourly" }, options: {} });
    await handler["~holqa"].invoke(undefined, createContext({ scheduledTime: "2026-10-17T10:00:00.000Z" }));
    expect(runs).toEqual(["2026-10-17T10:00:00.000Z"]);
  });

  it("rejects cron extensions that no binding evaluates portably", () => {
    expect(thrownCodes(() => schedule({ id: "last-day", cron: "0 0 L * *", timezone: "UTC", overlap: "skip" }))).toEqual(["HOLQA_DECLARATION_INVALID"]);
    expect(thrownCodes(() => schedule({ id: "minutes", cron: "61 * * * *", timezone: "UTC", overlap: "skip" }))).toEqual(["HOLQA_DECLARATION_INVALID"]);
  });

  it("tells handlers how a run was started", async () => {
    const hourly = schedule({ id: "hourly", cron: "0 * * * *", timezone: "UTC", overlap: "allow" });
    const runs: unknown[] = [];
    const handler = hourly.handle({ id: "hourly.report", handler: ({ scheduledTime, trigger, runId }) => {
      runs.push({ scheduledTime, trigger, runId });
    } });
    await handler["~holqa"].invoke(undefined, createContext({ scheduledTime: "2026-10-17T10:00:00.000Z", trigger: "manual", runId: "r-1" }));
    await handler["~holqa"].invoke(undefined, createContext({ scheduledTime: "2026-10-17T11:00:00.000Z" }));
    expect(runs).toEqual([
      { scheduledTime: "2026-10-17T10:00:00.000Z", trigger: "manual", runId: "r-1" },
      { scheduledTime: "2026-10-17T11:00:00.000Z", trigger: "cron", runId: undefined }
    ]);
  });

  it("types how a run was started", () => {
    expectTypeOf<ScheduleContext["trigger"]>().toEqualTypeOf<"cron" | "manual">();
    expectTypeOf<ScheduleContext["runId"]>().toEqualTypeOf<string | undefined>();
  });
});