import type {
  Described,
  HandlerDescriptor,
  InvocationLogger,
  ResourceDescriptor
} from "@holqa/experiment-model";

import {
  descriptorKey,
  experimentCodes,
  fail
} from "@holqa/experiment-model";

import {
  handlerDescriptor,
  resourceDescriptor
} from "@/internal/describe";

/** What happens when a run is due while the previous run is still in progress. */
export type ScheduleOverlap = "skip" | "allow";

/** Options accepted by {@link schedule}. */
export interface ScheduleOptions<Id extends string> {
  readonly id: Id;
  /** A five-field cron expression. */
  readonly cron: string;
  /** An IANA timezone, for example `UTC`. */
  readonly timezone: string;
  readonly overlap: ScheduleOverlap;
}

/** What a schedule handler receives. */
export interface ScheduleContext {
  /** The time the run was scheduled for (ISO 8601), not the time it started. */
  readonly scheduledTime: string;
  readonly signal: AbortSignal;
  readonly log: InvocationLogger;
}

/** Options accepted by {@link ScheduleHandle.handle}. */
export interface ScheduleHandlerOptions<HandlerId extends string> {
  readonly id: HandlerId;
  readonly handler: (context: ScheduleContext) => Promise<void> | void;
}

/** A registered schedule handler. */
export interface ScheduleHandler<ScheduleId extends string, HandlerId extends string> extends Described<HandlerDescriptor> {
  readonly kind: "schedule.handler";
  readonly id: HandlerId;
  readonly scheduleId: ScheduleId;
}

/** A typed handle to a declared schedule. */
export interface ScheduleHandle<Id extends string> extends Described<ResourceDescriptor> {
  readonly kind: "schedule";
  readonly id: Id;
  /**
   * Registers the schedule's handler.
   *
   * @param options - Handler identifier and function.
   * @returns The handler registration.
   */
  handle: <const HandlerId extends string>(options: ScheduleHandlerOptions<HandlerId>) => ScheduleHandler<Id, HandlerId>;
}

/**
 * Declares a cron schedule.
 *
 * @param options - Identifier, cron expression, timezone and overlap policy.
 * @returns A typed schedule handle.
 */
export function schedule<const Id extends string>(options: ScheduleOptions<Id>): ScheduleHandle<Id> {
  return Object.freeze({
    [descriptorKey]: resourceDescriptor("schedule", options.id, { cron: options.cron, timezone: options.timezone, overlap: options.overlap }, {}),
    kind: "schedule" as const,
    id: options.id,
    handle: <const HandlerId extends string>(registration: ScheduleHandlerOptions<HandlerId>): ScheduleHandler<Id, HandlerId> => Object.freeze({
      [descriptorKey]: handlerDescriptor(registration.id, { kind: "schedule.tick", resource: options.id }, {}, {}, async (_input, context) => {
        const { scheduledTime } = context.metadata;
        if (typeof scheduledTime !== "string")
          fail(experimentCodes.inputInvalid, `Schedule "${options.id}" was invoked without a scheduledTime.`);
        await registration.handler({
          scheduledTime,
          signal: context.signal,
          log: context.log
        });
        return undefined;
      }),
      kind: "schedule.handler" as const,
      id: registration.id,
      scheduleId: options.id
    })
  });
}