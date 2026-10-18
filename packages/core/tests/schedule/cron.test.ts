import type { CronSchedule } from "@/schedule/cron";

import {
  describe,
  expect,
  it
} from "bun:test";

import {
  isTimeZone,
  nextCronTime,
  parseCronSchedule
} from "@/schedule/cron";

/**
 * Parses a schedule a test knows to be valid.
 *
 * @param expression - The cron expression.
 * @param timezone - The time zone.
 * @returns The parsed schedule.
 * @throws {Error} When parsing fails, which indicates a broken test.
 */
function schedule(expression: string, timezone = "UTC"): CronSchedule {
  const parsed = parseCronSchedule(expression, timezone);
  if (!parsed.ok)
    throw new Error(parsed.error.message);
  return parsed.value;
}

/**
 * Lists the next run times of a schedule as ISO strings.
 *
 * @param cron - The schedule.
 * @param from - The ISO instant to start after.
 * @param count - How many runs to list.
 * @returns The run times.
 */
function runs(cron: CronSchedule, from: string, count: number): string[] {
  const result: string[] = [];
  let after = Date.parse(from);
  for (let index = 0; index < count; index += 1) {
    const next = nextCronTime(cron, after);
    if (next === undefined)
      break;
    result.push(new Date(next).toISOString());
    after = next;
  }
  return result;
}

describe("parseCronSchedule", () => {
  it.each([
    ["0 3 * * *"],
    ["*/15 * * * *"],
    ["0 9-17/2 * * MON-FRI"],
    ["0 0 1,15 jan,jul ?"],
    ["5 4 * * 7"]
  ])("accepts %p", (expression) => {
    expect(parseCronSchedule(expression, "UTC").ok).toBe(true);
  });

  it.each([
    ["0 3 * *"],
    ["60 * * * *"],
    ["* 24 * * *"],
    ["* * 0 * *"],
    ["0 0 L * *"],
    ["0 0 * * 1#2"],
    ["*/0 * * * *"],
    ["5-1 * * * *"],
    ["0 0 ? * ?/x"]
  ])("rejects %p with HOLQA_SCHEDULE_INVALID", (expression) => {
    const parsed = parseCronSchedule(expression, "UTC");
    expect(parsed.ok ? undefined : parsed.error.code).toBe("HOLQA_SCHEDULE_INVALID");
  });

  it("rejects unknown time zones", () => {
    const parsed = parseCronSchedule("0 3 * * *", "Mars/Olympus");
    expect(parsed.ok ? undefined : parsed.error.code).toBe("HOLQA_SCHEDULE_INVALID");
    expect(isTimeZone("Europe/Berlin")).toBe(true);
    expect(isTimeZone("")).toBe(false);
  });

  it("normalizes whitespace and treats day of week 7 as Sunday", () => {
    const cron = schedule("  0   3 * *  7 ");
    expect(cron.expression).toBe("0 3 * * 7");
    expect([...cron.daysOfWeek]).toEqual([0]);
  });
});

describe("nextCronTime", () => {
  it("returns times strictly after the given instant", () => {
    expect(runs(schedule("*/15 * * * *"), "2026-01-01T00:00:00.000Z", 3)).toEqual([
      "2026-01-01T00:15:00.000Z",
      "2026-01-01T00:30:00.000Z",
      "2026-01-01T00:45:00.000Z"
    ]);
    expect(runs(schedule("0 3 * * *"), "2026-01-01T03:00:00.001Z", 1)).toEqual(["2026-01-02T03:00:00.000Z"]);
  });

  it("evaluates fields in the schedule's time zone", () => {
    expect(runs(schedule("0 9 * * *", "America/New_York"), "2026-01-05T00:00:00.000Z", 1)).toEqual(["2026-01-05T14:00:00.000Z"]);
    expect(runs(schedule("0 9 * * *", "Asia/Tokyo"), "2026-01-05T00:00:00.000Z", 1)).toEqual(["2026-01-06T00:00:00.000Z"]);
  });

  it("matches either day field when both are restricted, and both otherwise", () => {
    // 2026-03-01 is a Sunday. "1st of the month OR Monday".
    expect(runs(schedule("0 0 1 * MON"), "2026-02-28T12:00:00.000Z", 3)).toEqual([
      "2026-03-01T00:00:00.000Z",
      "2026-03-02T00:00:00.000Z",
      "2026-03-09T00:00:00.000Z"
    ]);
    // Day of week unrestricted: only the 1st.
    expect(runs(schedule("0 0 1 * *"), "2026-02-28T12:00:00.000Z", 2)).toEqual(["2026-03-01T00:00:00.000Z", "2026-04-01T00:00:00.000Z"]);
  });

  it("finds leap days and reports schedules that never fire", () => {
    expect(runs(schedule("0 0 29 2 *"), "2026-01-01T00:00:00.000Z", 1)).toEqual(["2028-02-29T00:00:00.000Z"]);
    expect(nextCronTime(schedule("0 0 31 2 *"), Date.parse("2026-01-01T00:00:00.000Z"))).toBeUndefined();
  });

  describe("daylight-saving transitions (Europe/Berlin)", () => {
    // 2026-03-29: 02:00 CET jumps to 03:00 CEST (01:00Z). 2026-10-25: 03:00 CEST falls back to 02:00 CET (01:00Z).
    it("runs a local time inside the spring-forward gap once, at the end of the gap", () => {
      expect(runs(schedule("30 2 * * *", "Europe/Berlin"), "2026-03-28T12:00:00.000Z", 2)).toEqual([
        "2026-03-29T01:00:00.000Z",
        "2026-03-30T00:30:00.000Z"
      ]);
    });

    it("collapses every gap minute into one run at the end of the gap", () => {
      expect(runs(schedule("*/30 * * * *", "Europe/Berlin"), "2026-03-29T00:15:00.000Z", 3)).toEqual([
        "2026-03-29T00:30:00.000Z",
        "2026-03-29T01:00:00.000Z",
        "2026-03-29T01:30:00.000Z"
      ]);
    });

    it("runs a repeated local time once, at its first occurrence", () => {
      expect(runs(schedule("30 2 * * *", "Europe/Berlin"), "2026-10-24T12:00:00.000Z", 2)).toEqual([
        "2026-10-25T00:30:00.000Z",
        "2026-10-26T01:30:00.000Z"
      ]);
      expect(runs(schedule("0,30 * * * *", "Europe/Berlin"), "2026-10-25T00:15:00.000Z", 3)).toEqual([
        "2026-10-25T00:30:00.000Z",
        "2026-10-25T02:00:00.000Z",
        "2026-10-25T02:30:00.000Z"
      ]);
    });

    it("does not rerun repeated times when it starts during the second pass", () => {
      expect(runs(schedule("30 2 * * *", "Europe/Berlin"), "2026-10-25T01:10:00.000Z", 1)).toEqual(["2026-10-26T01:30:00.000Z"]);
    });
  });
});