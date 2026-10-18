import type {
  ResourceDescriptorOf,
  ScheduleRunResult,
  ScheduleTick
} from "@holqa/core";

import type { LocalEnvironment } from "@/environment";
import {
  application,
  scheduleResource,
  sequentialIds,
  stateDirectory
} from "@test/support/fixtures";
import {
  afterEach,
  describe,
  expect,
  it
} from "bun:test";

import { ManualClock } from "@/clock";
import { createLocalEnvironment } from "@/environment";

/** Cleanups to run after each test. */
const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse())
    cleanup();
});

/**
 * Creates an environment for one schedule, starting at 2026-10-18T10:00Z.
 *
 * @param schedule - The schedule descriptor.
 * @returns The environment and its clock.
 */
async function setup(schedule: ResourceDescriptorOf<"schedule">): Promise<{ readonly env: LocalEnvironment; readonly clock: ManualClock }> {
  const directory = stateDirectory();
  cleanups.push(directory.remove);
  const clock = new ManualClock(Date.parse("2026-10-18T10:00:00.000Z"));
  const env = await createLocalEnvironment({ app: application([schedule]), directory: directory.path, clock, createId: sequentialIds("run-"), env: {} });
  cleanups.push(() => env.close());
  return { env, clock };
}

/**
 * Creates a listener that records ticks and succeeds.
 *
 * @returns The listener and the ticks it saw.
 */
function recorder(): { readonly listener: (tick: ScheduleTick) => Promise<ScheduleRunResult>; readonly ticks: ScheduleTick[] } {
  const ticks: ScheduleTick[] = [];
  return { ticks, listener: async (tick) => {
    ticks.push(tick);
    return { status: "succeeded", invocationId: `inv-${ticks.length}` };
  } };
}

describe("local scheduler", () => {
  it("reports runs at their cron times as the clock advances, and records results", async () => {
    const hourly = scheduleResource("hourly", "0 * * * *") as ResourceDescriptorOf<"schedule">;
    const { env, clock } = await setup(hourly);
    const { listener, ticks } = recorder();
    const subscription = await env.binding.sources!.schedule!(hourly).start(listener);
    expect(env.scheduler.nextRun("hourly")).toBe("2026-10-18T11:00:00.000Z");
    clock.advance(3 * 3_600_000);
    await env.scheduler.idle();
    expect(ticks.map(tick => `${tick.scheduledTime}:${tick.trigger}`)).toEqual([
      "2026-10-18T11:00:00.000Z:cron",
      "2026-10-18T12:00:00.000Z:cron",
      "2026-10-18T13:00:00.000Z:cron"
    ]);
    expect(env.scheduler.runs("hourly").map(run => [run.scheduledTime, run.status, run.invocationId])).toEqual([
      ["2026-10-18T13:00:00.000Z", "succeeded", "inv-3"],
      ["2026-10-18T12:00:00.000Z", "succeeded", "inv-2"],
      ["2026-10-18T11:00:00.000Z", "succeeded", "inv-1"]
    ]);
    await subscription.stop();
    clock.advance(3_600_000);
    expect(ticks).toHaveLength(3);
    expect(env.scheduler.nextRun("hourly")).toBeUndefined();
  });

  it("runs only the latest due occurrence after a late wake-up and records the others as missed", async () => {
    const hourly = scheduleResource("hourly", "0 * * * *") as ResourceDescriptorOf<"schedule">;
    const { env, clock } = await setup(hourly);
    const { listener, ticks } = recorder();
    await env.binding.sources!.schedule!(hourly).start(listener);
    clock.jump(3 * 3_600_000 + 60_000);
    await env.scheduler.idle();
    expect(ticks.map(tick => tick.scheduledTime)).toEqual(["2026-10-18T13:00:00.000Z"]);
    expect(env.scheduler.runs("hourly").map(run => `${run.scheduledTime}:${run.status}`)).toEqual([
      "2026-10-18T13:00:00.000Z:succeeded",
      "2026-10-18T12:00:00.000Z:missed",
      "2026-10-18T11:00:00.000Z:missed"
    ]);
    expect(env.scheduler.nextRun("hourly")).toBe("2026-10-18T14:00:00.000Z");
  });

  it("does not backfill runs that were due before a runtime subscribed", async () => {
    const hourly = scheduleResource("hourly", "0 * * * *") as ResourceDescriptorOf<"schedule">;
    const { env, clock } = await setup(hourly);
    clock.advance(5 * 3_600_000);
    const { listener, ticks } = recorder();
    await env.binding.sources!.schedule!(hourly).start(listener);
    await env.scheduler.idle();
    expect(ticks).toEqual([]);
    expect(env.scheduler.runs("hourly")).toEqual([]);
  });

  it("follows the schedule's time zone across a daylight-saving change", async () => {
    const daily = scheduleResource("daily", "30 2 * * *", "skip", "Europe/Berlin") as ResourceDescriptorOf<"schedule">;
    const directory = stateDirectory();
    cleanups.push(directory.remove);
    const clock = new ManualClock(Date.parse("2026-03-28T12:00:00.000Z"));
    const env = await createLocalEnvironment({ app: application([daily]), directory: directory.path, clock, env: {} });
    cleanups.push(() => env.close());
    const { listener, ticks } = recorder();
    await env.binding.sources!.schedule!(daily).start(listener);
    clock.advance(2 * 86_400_000);
    await env.scheduler.idle();
    expect(ticks.map(tick => tick.scheduledTime)).toEqual(["2026-03-29T01:00:00.000Z", "2026-03-30T00:30:00.000Z"]);
  });

  it("triggers runs manually through the subscribed runtime", async () => {
    const hourly = scheduleResource("hourly", "0 * * * *") as ResourceDescriptorOf<"schedule">;
    const { env } = await setup(hourly);
    await expect(env.scheduler.trigger("hourly")).rejects.toThrow("HOLQA_RUNTIME_NOT_RUNNING");
    const { listener, ticks } = recorder();
    await env.binding.sources!.schedule!(hourly).start(listener);
    const run = await env.scheduler.trigger("hourly");
    expect(run).toMatchObject({ scheduleId: "hourly", trigger: "manual", status: "succeeded", scheduledTime: "2026-10-18T10:00:00.000Z", invocationId: "inv-1" });
    expect(ticks).toEqual([{ runId: run.runId, scheduledTime: "2026-10-18T10:00:00.000Z", trigger: "manual" }]);
  });

  it.each([
    ["0 0 31 2 *", "UTC"],
    ["0 0 * * *", "Mars/Olympus"]
  ])("refuses schedules that cannot be evaluated: %p in %p", async (cron, timezone) => {
    const broken = scheduleResource("broken", cron, "skip", timezone) as ResourceDescriptorOf<"schedule">;
    const { env } = await setup(broken);
    await expect(env.binding.sources!.schedule!(broken).start(recorder().listener)).rejects.toThrow("HOLQA_SCHEDULE_INVALID");
  });
});