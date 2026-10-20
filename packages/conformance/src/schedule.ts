import type {
  ScheduleRunResult,
  ScheduleSource,
  ScheduleTick
} from "@holqa/core";

import type {
  ConformanceCase,
  ConformanceSuite,
  ConformanceTime
} from "@/suite";

import {
  expectEqual,
  expectThat
} from "@/suite";

/** A schedule of the provider under test that fires every minute (`* * * * *`, UTC). */
export interface ScheduleFixture {
  readonly source: ScheduleSource;
  readonly close: () => Promise<void>;
}

/**
 * What the schedule cases need. Schedules fire on the minute, so the
 * harness must control time (a manual clock); real-time harnesses would
 * need minutes per case.
 */
export interface ScheduleHarness {
  /** Opens a schedule that fires every minute. */
  readonly open: () => Promise<ScheduleFixture>;
  readonly time: ConformanceTime;
}

/** The contract name of the schedule cases. */
const contract = "schedule";

/**
 * Runs a case against a fresh schedule and always closes it.
 *
 * @param harness - What the cases need to reach the provider.
 * @param body - The case.
 */
async function withSchedule(harness: ScheduleHarness, body: (schedule: ScheduleFixture) => Promise<void>): Promise<void> {
  const schedule = await harness.open();
  try {
    await body(schedule);
  } finally {
    await schedule.close();
  }
}

/**
 * The normative behaviour of the `schedule` contract (version 1): due runs
 * are reported once per due time with their scheduled time and a run
 * identifier, and stopping a subscription stops reporting.
 */
export const scheduleConformance: ConformanceSuite<ScheduleHarness> = Object.freeze({
  contract,
  cases: Object.freeze<ConformanceCase<ScheduleHarness>[]>([
    {
      name: "due runs are reported once per due time with their scheduled time",
      run: harness => withSchedule(harness, async (schedule) => {
        const ticks: ScheduleTick[] = [];
        const subscription = await schedule.source.start(async (tick): Promise<ScheduleRunResult> => {
          ticks.push(tick);
          return { status: "succeeded", invocationId: `inv-${ticks.length}` };
        });
        try {
          await harness.time.advance(60_000);
          await harness.time.advance(60_000);
        } finally {
          await subscription.stop();
        }
        expectThat(contract, ticks.length === 2, `Two minutes of a schedule firing every minute must report two runs, not ${ticks.length}.`);
        for (const tick of ticks) {
          expectEqual(contract, tick.trigger, "cron", "A scheduled run's trigger");
          expectEqual(contract, new Date(tick.scheduledTime).getUTCSeconds(), 0, "The scheduled time's seconds");
          expectThat(contract, typeof tick.runId === "string" && tick.runId !== "", "A run must have an identifier.");
        }
        expectThat(contract, ticks[0]!.runId !== ticks[1]!.runId, "Two runs must have different identifiers.");
        expectEqual(contract, Date.parse(ticks[1]!.scheduledTime) - Date.parse(ticks[0]!.scheduledTime), 60_000, "The time between two runs");
      })
    },
    {
      name: "a stopped subscription reports no further runs",
      run: harness => withSchedule(harness, async (schedule) => {
        let count = 0;
        const subscription = await schedule.source.start(async () => {
          count += 1;
          return { status: "succeeded", invocationId: "inv" };
        });
        await subscription.stop();
        await harness.time.advance(180_000);
        expectEqual(contract, count, 0, "Runs reported after stop");
      })
    }
  ])
});