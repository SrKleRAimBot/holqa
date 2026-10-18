import type {
  CronSchedule,
  ResourceDescriptorOf,
  ScheduleListener,
  ScheduleRunResult,
  ScheduleRunTrigger,
  ScheduleSource
} from "@holqa/core";
import type { Database } from "bun:sqlite";

import type { Clock } from "@/clock";

import {
  createDiagnostic,
  diagnosticCodes,
  failWith,
  HolqaError,
  nextCronTime,
  parseCronSchedule
} from "@holqa/core";

/** Where a recorded run ended up. `missed` runs were due while the scheduler was late and never ran. */
export type LocalRunStatus = "running" | "succeeded" | "failed" | "skipped" | "missed";

/** One recorded run of a schedule. */
export interface LocalScheduleRun {
  readonly runId: string;
  readonly scheduleId: string;
  /** When the run was due (ISO 8601); for a manual run, when it was requested. */
  readonly scheduledTime: string;
  readonly trigger: ScheduleRunTrigger;
  readonly status: LocalRunStatus;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly code?: string;
  readonly message?: string;
  readonly invocationId?: string;
}

/** Inspection and manual triggering for the local scheduler. */
export interface LocalScheduler {
  /**
   * Starts a run now, through the runtime and its overlap policy, and resolves
   * with its record once it has finished or was skipped.
   *
   * @throws {HolqaError} `HOLQA_RUNTIME_NOT_RUNNING` when no runtime receives the schedule's runs.
   */
  readonly trigger: (scheduleId: string) => Promise<LocalScheduleRun>;
  /** Lists a schedule's recorded runs, newest first. */
  readonly runs: (scheduleId: string, limit?: number) => LocalScheduleRun[];
  /** When the schedule's next cron run is due (ISO 8601), or `undefined` when no runtime receives its runs. */
  readonly nextRun: (scheduleId: string) => string | undefined;
  /** Waits until no run is in progress. */
  readonly idle: () => Promise<void>;
}

/** Settings of {@link createLocalScheduler}. */
export interface LocalSchedulerSettings {
  readonly database: Database;
  readonly clock: Clock;
  readonly createId: () => string;
}

/** The most due occurrences examined for one late wake-up: all but the latest are recorded as missed. */
const maxDueRuns = 10_000;

/** A row of the `schedule_runs` table. */
interface RunRow {
  readonly run_id: string;
  readonly schedule: string;
  readonly scheduled_time: number;
  readonly trigger: ScheduleRunTrigger;
  readonly status: LocalRunStatus;
  readonly started_at: number | null;
  readonly finished_at: number | null;
  readonly code: string | null;
  readonly message: string | null;
  readonly invocation_id: string | null;
}

/** The scheduler state of one subscribed schedule. */
interface ActiveSchedule {
  readonly cron: CronSchedule;
  readonly listener: ScheduleListener;
  next: number | undefined;
  cancel: () => void;
}

/**
 * Creates the scheduler of a local environment. It is driven entirely by the
 * environment's clock, so tests can move time and observe runs
 * deterministically.
 *
 * Missed runs are defined as follows:
 *
 * - Runs due while no runtime received the schedule (the application was not
 *   running) are neither run nor recorded; there is no backfill.
 * - When the scheduler wakes up late (a blocked event loop, a suspended
 *   process, a clock that jumped), only the most recent due run is started;
 *   the earlier ones are recorded with status `missed`.
 *
 * Daylight-saving transitions follow the cron rules of `@holqa/core`.
 *
 * @param settings - The database, clock and identifiers.
 * @returns The source factory and the inspection API.
 */
export function createLocalScheduler(settings: LocalSchedulerSettings): {
  readonly source: (resource: ResourceDescriptorOf<"schedule">) => ScheduleSource;
  readonly scheduler: LocalScheduler;
} {
  const { database, clock, createId } = settings;
  const active = new Map<string, ActiveSchedule>();
  const inFlight = new Set<Promise<unknown>>();

  /**
   * Records a run that will not start.
   *
   * @param scheduleId - The schedule's logical identifier.
   * @param scheduledTime - When it was due.
   * @param trigger - How it was requested.
   * @param status - `missed`.
   */
  const record = (scheduleId: string, scheduledTime: number, trigger: ScheduleRunTrigger, status: LocalRunStatus): void => {
    database.query("INSERT INTO schedule_runs (run_id, schedule, scheduled_time, trigger, status) VALUES (?, ?, ?, ?, ?)").run(createId(), scheduleId, scheduledTime, trigger, status);
  };

  /**
   * Starts one run and records its result.
   *
   * @param scheduleId - The schedule's logical identifier.
   * @param schedule - Its subscription.
   * @param scheduledTime - When the run was due.
   * @param trigger - How it was requested.
   * @returns The run's identifier and a promise of its result.
   */
  const start = (scheduleId: string, schedule: ActiveSchedule, scheduledTime: number, trigger: ScheduleRunTrigger): { readonly runId: string; readonly done: Promise<void> } => {
    const runId = createId();
    database.query("INSERT INTO schedule_runs (run_id, schedule, scheduled_time, trigger, status, started_at) VALUES (?, ?, ?, ?, 'running', ?)").run(runId, scheduleId, scheduledTime, trigger, clock.now());
    const done = schedule.listener({ runId, scheduledTime: new Date(scheduledTime).toISOString(), trigger })
      .catch((error: unknown): ScheduleRunResult => ({ status: "failed", code: diagnosticCodes.handlerFailed, message: error instanceof Error ? error.message : String(error) }))
      .then((result) => {
        database.query("UPDATE schedule_runs SET status = ?, finished_at = ?, code = ?, message = ?, invocation_id = ? WHERE run_id = ?")
          .run(result.status, clock.now(), result.status === "succeeded" ? null : result.code, result.status === "succeeded" ? null : result.message, result.status === "skipped" ? null : result.invocationId ?? null, runId);
      });
    inFlight.add(done);
    void done.finally(() => inFlight.delete(done));
    return { runId, done };
  };

  /**
   * Arms the timer for a schedule's next cron run.
   *
   * @param scheduleId - The schedule's logical identifier.
   * @param schedule - Its subscription.
   */
  function arm(scheduleId: string, schedule: ActiveSchedule): void {
    schedule.next = nextCronTime(schedule.cron, clock.now());
    if (schedule.next === undefined)
      return;
    schedule.cancel = clock.setTimer(schedule.next - clock.now(), () => fire(scheduleId, schedule));
  }

  /**
   * Handles a due timer: starts the latest due run, records earlier missed ones, and re-arms.
   *
   * @param scheduleId - The schedule's logical identifier.
   * @param schedule - Its subscription.
   */
  function fire(scheduleId: string, schedule: ActiveSchedule): void {
    if (active.get(scheduleId) !== schedule || schedule.next === undefined)
      return;
    const now = clock.now();
    const due: number[] = [];
    // After a very long jump, stop looking after `maxDueRuns` occurrences; the scheduler re-arms from now.
    for (let time: number | undefined = schedule.next; time !== undefined && time <= now && due.length < maxDueRuns; time = nextCronTime(schedule.cron, time))
      due.push(time);
    for (const missed of due.slice(0, -1))
      record(scheduleId, missed, "cron", "missed");
    const latest = due.at(-1);
    if (latest !== undefined)
      start(scheduleId, schedule, latest, "cron");
    arm(scheduleId, schedule);
  }

  /**
   * Reads a schedule's recorded runs.
   *
   * @param scheduleId - The schedule's logical identifier.
   * @param limit - The most runs to return.
   * @returns The runs, newest first.
   */
  const runs = (scheduleId: string, limit = 100): LocalScheduleRun[] => database
    .query<RunRow, [string, number]>("SELECT * FROM schedule_runs WHERE schedule = ? ORDER BY seq DESC LIMIT ?")
    .all(scheduleId, limit)
    .map(toRun);

  return {
    source: resource => Object.freeze({
      start: async (listener: ScheduleListener) => {
        const parsed = parseCronSchedule(resource.config.cron, resource.config.timezone);
        if (!parsed.ok)
          throw new HolqaError(parsed.error);
        if (nextCronTime(parsed.value, clock.now()) === undefined)
          throw new HolqaError(createDiagnostic({ code: diagnosticCodes.scheduleInvalid, severity: "error", message: `The schedule "${resource.id}" ("${resource.config.cron}") never fires.` }));
        active.get(resource.id)?.cancel();
        const schedule: ActiveSchedule = { cron: parsed.value, listener, next: undefined, cancel: () => {} };
        active.set(resource.id, schedule);
        arm(resource.id, schedule);
        return Object.freeze({
          stop: async () => {
            schedule.cancel();
            if (active.get(resource.id) === schedule)
              active.delete(resource.id);
          }
        });
      }
    }),
    scheduler: Object.freeze({
      trigger: async (scheduleId: string) => {
        const schedule = active.get(scheduleId);
        if (schedule === undefined)
          failWith(diagnosticCodes.runtimeNotRunning, `No runtime receives the runs of schedule "${scheduleId}".`, "Start a runtime with this environment's binding first.");
        const { runId, done } = start(scheduleId, schedule, clock.now(), "manual");
        await done;
        return toRun(database.query<RunRow, [string]>("SELECT * FROM schedule_runs WHERE run_id = ?").get(runId)!);
      },
      runs,
      nextRun: (scheduleId: string) => {
        const next = active.get(scheduleId)?.next;
        return next === undefined ? undefined : new Date(next).toISOString();
      },
      idle: async () => {
        while (inFlight.size > 0)
          await Promise.allSettled([...inFlight]);
      }
    })
  };
}

/**
 * Converts a run row into its inspection form.
 *
 * @param row - A row read from the state database.
 * @returns The run as inspection reports it.
 */
function toRun(row: RunRow): LocalScheduleRun {
  /**
   * Formats an optional time.
   *
   * @param time - Epoch milliseconds or `null`.
   * @returns The ISO 8601 text, or `undefined`.
   */
  const iso = (time: number | null): string | undefined => time === null ? undefined : new Date(time).toISOString();
  const startedAt = iso(row.started_at);
  const finishedAt = iso(row.finished_at);
  return Object.freeze({
    runId: row.run_id,
    scheduleId: row.schedule,
    scheduledTime: new Date(row.scheduled_time).toISOString(),
    trigger: row.trigger,
    status: row.status,
    ...startedAt === undefined ? {} : { startedAt },
    ...finishedAt === undefined ? {} : { finishedAt },
    ...row.code === null ? {} : { code: row.code },
    ...row.message === null ? {} : { message: row.message },
    ...row.invocation_id === null ? {} : { invocationId: row.invocation_id }
  });
}