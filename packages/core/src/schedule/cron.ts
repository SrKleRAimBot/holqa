import type { Diagnostic } from "@/diagnostics/diagnostic";
import type { Result } from "@/result";

import { diagnosticCodes } from "@/diagnostics/codes";
import { createDiagnostic } from "@/diagnostics/diagnostic";
import {
  err,
  ok
} from "@/result";

// Cron semantics, shared by every binding that evaluates schedules itself:
//
// - Five fields: minute (0-59), hour (0-23), day of month (1-31), month (1-12
//   or JAN-DEC) and day of week (0-7 or SUN-SAT; 0 and 7 are Sunday). Each
//   field is `*`, a value, a range `a-b`, a step `*/n`, `a/n` or `a-b/n`, or a
//   comma-separated list of these. `?` means `*` in the two day fields.
//   Extensions such as `L`, `W`, `#` and seconds are rejected.
// - When both day fields are restricted (neither starts with `*` or `?`), a day
//   matches if either matches, as in classic cron. Otherwise both must match.
// - Fields are matched against the wall-clock time in the schedule's IANA time
//   zone, at minute precision.
// - Daylight-saving transitions: a matching local time that does not exist
//   (clocks jump forward) runs once at the first instant after the gap; a
//   local time that occurs twice (clocks fall back) runs once, at its first
//   occurrence. So each matching local wall-clock time runs at most once.

/** A parsed, evaluable cron schedule. */
export interface CronSchedule {
  /** The expression, with fields separated by single spaces. */
  readonly expression: string;
  readonly timezone: string;
  readonly minutes: ReadonlySet<number>;
  readonly hours: ReadonlySet<number>;
  readonly daysOfMonth: ReadonlySet<number>;
  readonly months: ReadonlySet<number>;
  /** Days of the week, 0 (Sunday) to 6. */
  readonly daysOfWeek: ReadonlySet<number>;
  /** Whether both day fields are restricted, so that either may match. */
  readonly eitherDay: boolean;
}

/** How one cron field is read. */
interface FieldSpec {
  readonly name: string;
  readonly min: number;
  readonly max: number;
  readonly names?: readonly string[];
  /** Whether `?` is accepted as `*`. */
  readonly question?: boolean;
}

/** The five fields, in order. */
const fieldSpecs: readonly FieldSpec[] = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day of month", min: 1, max: 31, question: true },
  { name: "month", min: 1, max: 12, names: ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"] },
  { name: "day of week", min: 0, max: 7, names: ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"], question: true }
];

/** One minute in milliseconds. */
const minuteMs = 60_000;

/** One day in milliseconds. */
const dayMs = 86_400_000;

/** How many search steps to take before deciding a schedule never fires (about ten years of days). */
const searchLimit = 100_000;

/** Wall-clock formatters by time zone; creating one is expensive. */
const formatters = new Map<string, Intl.DateTimeFormat>();

/**
 * Parses a five-field cron expression and checks its time zone.
 *
 * @example
 * ```ts
 * const parsed = parseCronSchedule("30 2 * * MON-FRI", "Europe/Berlin");
 * if (parsed.ok)
 *   nextCronTime(parsed.value, Date.now());
 * ```
 *
 * @param expression - Five whitespace-separated fields, for example `30 2 * * MON-FRI`.
 * @param timezone - An IANA time zone name, for example `UTC` or `Europe/Berlin`.
 * @returns The schedule, or a `HOLQA_SCHEDULE_INVALID` diagnostic describing the first problem.
 */
export function parseCronSchedule(expression: string, timezone: string): Result<CronSchedule, Diagnostic> {
  if (typeof expression !== "string")
    return err(invalid("The cron expression must be a string."));
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5)
    return err(invalid(`The cron expression "${expression}" must have five fields (minute, hour, day of month, month, day of week).`));
  const sets: Array<ReadonlySet<number>> = [];
  for (const [index, spec] of fieldSpecs.entries()) {
    const parsed = parseField(fields[index]!, spec);
    if (typeof parsed === "string")
      return err(invalid(`The cron expression "${expression}" has an invalid ${spec.name} field: ${parsed}.`));
    sets.push(parsed);
  }
  if (!isTimeZone(timezone))
    return err(invalid(`"${String(timezone)}" is not an IANA time zone this runtime knows.`, "Use a name such as \"UTC\" or \"Europe/Berlin\"."));
  const daysOfWeek = new Set([...sets[4]!].map(day => day % 7));
  /**
   * Reports whether a day field restricts the days, as opposed to `*` or `?`.
   *
   * @param field - A day-of-month or day-of-week field.
   * @returns `true` when the field does not start with a wildcard.
   */
  const restricted = (field: string): boolean => !field.startsWith("*") && !field.startsWith("?");
  return ok(Object.freeze({
    expression: fields.join(" "),
    timezone,
    minutes: sets[0]!,
    hours: sets[1]!,
    daysOfMonth: sets[2]!,
    months: sets[3]!,
    daysOfWeek,
    eitherDay: restricted(fields[2]!) && restricted(fields[4]!)
  }));
}

/**
 * Returns the first instant strictly after `after` at which the schedule
 * fires, following the daylight-saving rules described in this module.
 *
 * @param schedule - A parsed schedule.
 * @param after - Epoch milliseconds; the result is later than this instant.
 * @returns Epoch milliseconds of the next run, or `undefined` when the schedule cannot fire within about ten years (for example `0 0 31 2 *`).
 */
export function nextCronTime(schedule: CronSchedule, after: number): number | undefined {
  let wall = Math.floor(toWallClock(after, schedule.timezone) / minuteMs) * minuteMs + minuteMs;
  for (let step = 0; step < searchLimit; step += 1) {
    const candidate = nextMatchingWallTime(schedule, wall);
    if (candidate === undefined)
      return undefined;
    const instant = wallClockToInstant(candidate, schedule.timezone);
    if (instant > after)
      return instant;
    // A repeated local time whose first occurrence has already passed.
    wall = candidate + minuteMs;
  }
  return undefined;
}

/**
 * Reports whether the runtime knows an IANA time zone.
 *
 * @param timezone - A candidate time zone name.
 * @returns `true` when wall-clock times can be computed in it.
 */
export function isTimeZone(timezone: unknown): timezone is string {
  if (typeof timezone !== "string" || timezone.trim() === "")
    return false;
  try {
    formatterFor(timezone);
    return true;
  } catch {
    // `Intl.DateTimeFormat` throws a RangeError for unknown zones; that is the answer, not a failure.
    return false;
  }
}

/**
 * Finds the first wall-clock minute at or after `start` that matches the
 * schedule. Wall-clock times are represented as epoch milliseconds of the
 * same fields in UTC, so plain date arithmetic applies.
 *
 * @param schedule - The parsed fields to match.
 * @param start - The wall-clock minute to start at.
 * @returns The matching wall-clock minute, or `undefined` when none is found within the search limit.
 */
function nextMatchingWallTime(schedule: CronSchedule, start: number): number | undefined {
  let time = start;
  for (let step = 0; step < searchLimit; step += 1) {
    const date = new Date(time);
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth();
    const day = date.getUTCDate();
    const hour = date.getUTCHours();
    if (!schedule.months.has(month + 1)) {
      time = Date.UTC(year, month + 1, 1);
      continue;
    }
    if (!dayMatches(schedule, day, date.getUTCDay())) {
      time = Date.UTC(year, month, day + 1);
      continue;
    }
    if (!schedule.hours.has(hour)) {
      time = Date.UTC(year, month, day, hour + 1);
      continue;
    }
    if (!schedule.minutes.has(date.getUTCMinutes())) {
      time += minuteMs;
      continue;
    }
    return time;
  }
  return undefined;
}

/**
 * Applies the day-of-month and day-of-week fields.
 *
 * @param schedule - The parsed day fields and whether either may match.
 * @param dayOfMonth - 1 to 31.
 * @param dayOfWeek - 0 (Sunday) to 6.
 * @returns Whether the day matches.
 */
function dayMatches(schedule: CronSchedule, dayOfMonth: number, dayOfWeek: number): boolean {
  const monthDay = schedule.daysOfMonth.has(dayOfMonth);
  const weekDay = schedule.daysOfWeek.has(dayOfWeek);
  return schedule.eitherDay ? monthDay || weekDay : monthDay && weekDay;
}

/**
 * Converts a wall-clock time in a zone to an instant. A time inside a
 * daylight-saving gap maps to the first instant after the gap; a repeated
 * time maps to its first occurrence.
 *
 * @param wall - Wall-clock fields encoded as UTC epoch milliseconds.
 * @param timezone - The time zone.
 * @returns Epoch milliseconds.
 */
function wallClockToInstant(wall: number, timezone: string): number {
  const before = offsetAt(wall - dayMs, timezone);
  const after = offsetAt(wall + dayMs, timezone);
  const candidates = [wall - before, wall - after].filter(instant => toWallClock(instant, timezone) === wall);
  if (candidates.length > 0)
    return Math.min(...candidates);
  // The local time does not exist: find the transition, the first minute with the later offset.
  let low = wall - Math.max(before, after);
  let high = wall - Math.min(before, after);
  while (high - low > minuteMs) {
    const middle = low + Math.floor((high - low) / 2 / minuteMs) * minuteMs;
    if (offsetAt(middle, timezone) === after)
      high = middle;
    else
      low = middle;
  }
  return high;
}

/**
 * Returns a zone's offset from UTC at an instant.
 *
 * @param instant - Epoch milliseconds.
 * @param timezone - The time zone.
 * @returns The offset in milliseconds (wall clock minus UTC).
 */
function offsetAt(instant: number, timezone: string): number {
  const truncated = Math.floor(instant / minuteMs) * minuteMs;
  return toWallClock(truncated, timezone) - truncated;
}

/**
 * Returns the wall-clock time of an instant in a zone, encoded as the UTC
 * epoch milliseconds of the same calendar fields, truncated to seconds.
 *
 * @param instant - Epoch milliseconds.
 * @param timezone - The time zone.
 * @returns The encoded wall-clock time.
 */
function toWallClock(instant: number, timezone: string): number {
  const parts: Partial<Record<Intl.DateTimeFormatPartTypes, number>> = {};
  for (const part of formatterFor(timezone).formatToParts(instant)) {
    if (part.type !== "literal")
      parts[part.type] = Number(part.value);
  }
  return Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour! % 24, parts.minute!, parts.second!);
}

/**
 * Returns a cached formatter that reports numeric wall-clock fields in a zone.
 *
 * @param timezone - The time zone.
 * @returns A formatter with a 24-hour clock and numeric fields.
 * @throws {RangeError} When the runtime does not know the zone.
 */
function formatterFor(timezone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timezone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric"
    });
    formatters.set(timezone, formatter);
  }
  return formatter;
}

/**
 * Parses one cron field into the set of values it matches.
 *
 * @param field - The field text.
 * @param spec - The field's range and names.
 * @returns The matched values, or a description of the problem.
 */
function parseField(field: string, spec: FieldSpec): ReadonlySet<number> | string {
  const values = new Set<number>();
  for (const item of field.split(",")) {
    const [range, stepText, extra] = item.split("/");
    if (extra !== undefined || range === undefined || range === "")
      return `"${item}" is not a value, range or step`;
    const step = stepText === undefined ? 1 : parseNumber(stepText);
    if (step === undefined || step < 1)
      return `"${item}" has an invalid step`;
    let low: number;
    let high: number;
    if (range === "*" || (range === "?" && spec.question === true)) {
      low = spec.min;
      high = spec.max;
    } else {
      const [startText, endText, rest] = range.split("-");
      const start = parseValue(startText ?? "", spec);
      const end = endText === undefined ? (stepText === undefined ? start : spec.max) : parseValue(endText, spec);
      if (rest !== undefined || start === undefined || end === undefined)
        return `"${item}" is outside ${spec.min}-${spec.max} or not a number${spec.names === undefined ? "" : " or name"}`;
      if (start > end)
        return `the range "${range}" ends before it starts`;
      low = start;
      high = end;
    }
    for (let value = low; value <= high; value += step)
      values.add(value);
  }
  return values;
}

/**
 * Parses one field value: a number in range, or a name.
 *
 * @param text - A number or a name such as `JAN` or `mon`.
 * @param spec - The field's range and names.
 * @returns The value, or `undefined` when it is invalid.
 */
function parseValue(text: string, spec: FieldSpec): number | undefined {
  const named = spec.names?.indexOf(text.toUpperCase()) ?? -1;
  if (named >= 0)
    return named + (spec.min === 1 ? 1 : 0);
  const value = parseNumber(text);
  return value !== undefined && value >= spec.min && value <= spec.max ? value : undefined;
}

/**
 * Parses an unsigned decimal integer.
 *
 * @param text - Up to four decimal digits.
 * @returns The number, or `undefined` when the text is not one.
 */
function parseNumber(text: string): number | undefined {
  return /^\d{1,4}$/.test(text) ? Number(text) : undefined;
}

/**
 * Builds a `HOLQA_SCHEDULE_INVALID` diagnostic.
 *
 * @param message - What is wrong.
 * @param hint - Optional guidance.
 * @returns The diagnostic.
 */
function invalid(message: string, hint = "Use five fields with numbers, names, *, ranges, lists and steps, for example \"0 3 * * *\"."): Diagnostic {
  return createDiagnostic({ code: diagnosticCodes.scheduleInvalid, severity: "error", message, hint });
}