import type {
  HandlerInvoke,
  InvocationLineage,
  InvocationLogger,
  ResourceDescriptorOf,
  ScheduleOverlap,
  ScheduleRunTrigger
} from "@holqa/core";

import type { HandlerEventOptions } from "@/internal/event-options";
import type {
  HandlerRegistration,
  ResourceHandle
} from "@/resources/handle";
import type { CheckResourceId } from "@/types/checks";

import {
  descriptorKey,
  descriptorProtocol,
  parseCronSchedule
} from "@holqa/core";

import {
  DeclarationProblems,
  definedEntries,
  freezeJson,
  requireOptions
} from "@/internal/declaration";
import { readEventOptions } from "@/internal/event-options";

/** The overlap policies a schedule may require. */
const overlapPolicies: readonly ScheduleOverlap[] = ["skip", "allow"];

/**
 * Options accepted by {@link schedule}.
 *
 * @typeParam Id - The literal identifier.
 */
export interface ScheduleOptions<Id extends string> {
  /** The persistent identity of the schedule. */
  readonly id: Id;
  /** A five-field cron expression, for example `0 3 * * *`. */
  readonly cron: string;
  /** An IANA time zone name, for example `UTC`. */
  readonly timezone: string;
  /** What happens when a run is due while the previous one is still in progress. */
  readonly overlap: ScheduleOverlap;
}

/** What a schedule handler receives. */
export interface ScheduleContext {
  /** The time the run was scheduled for (ISO 8601), not the time it started. For a manual run, when it was requested. */
  readonly scheduledTime: string;
  /** Whether the cron expression or a manual request started the run. */
  readonly trigger: ScheduleRunTrigger;
  /** Identifies the run in the scheduler's records, when the run came from a scheduler. */
  readonly runId?: string;
  /** The run's lineage; a scheduled run is the root of its operation (depth 0). Absent when the runtime does not track lineage. */
  readonly lineage?: InvocationLineage;
  readonly signal: AbortSignal;
  readonly log: InvocationLogger;
}

/**
 * Options accepted by {@link ScheduleHandle.handle}.
 *
 * @typeParam HandlerId - The handler's literal identifier.
 */
export interface ScheduleHandlerOptions<HandlerId extends string> {
  /** The handler's persistent identity. */
  readonly id: HandlerId;
  readonly handler: (context: ScheduleContext) => Promise<void> | void;
  /** Event safety declarations: publications analysis cannot see, and the publication limit. */
  readonly events?: HandlerEventOptions;
}

/**
 * A registered schedule handler.
 *
 * @typeParam ScheduleId - The schedule's identifier.
 * @typeParam HandlerId - The handler's identifier.
 */
export interface ScheduleHandler<ScheduleId extends string, HandlerId extends string> extends HandlerRegistration<"schedule.tick", HandlerId, ScheduleId> {}

/**
 * A typed handle to a declared schedule.
 *
 * @typeParam Id - The literal identifier.
 */
export interface ScheduleHandle<Id extends string> extends ResourceHandle<"schedule", Id> {
  /** Registers the schedule's handler. Registration is declarative. */
  readonly handle: <const HandlerId extends string>(options: ScheduleHandlerOptions<HandlerId> & CheckResourceId<HandlerId>) => ScheduleHandler<Id, HandlerId>;
}

/**
 * Declares a cron schedule. Pure: performs no I/O, starts no timer and creates
 * no infrastructure. The time zone name is validated by the binding that runs
 * the schedule, because time zone data differs between runtimes.
 *
 * @param options - Identifier, cron expression, time zone and overlap policy.
 * @returns A typed schedule handle.
 * @throws {HolqaError} `HOLQA_RESOURCE_ID_INVALID` for an invalid identifier, or `HOLQA_DECLARATION_INVALID` for a malformed option.
 */
export function schedule<const Id extends string>(options: ScheduleOptions<Id> & CheckResourceId<Id>): ScheduleHandle<Id> {
  const raw = requireOptions(options, "schedule");
  const problems = new DeclarationProblems(`schedule "${String(raw.id)}"`);
  const idCandidate = problems.identifier(raw.id, "schedule id");
  // The fields are checked here; the time zone is checked by the binding that runs the schedule.
  const cron = typeof raw.cron === "string" ? parseCronSchedule(raw.cron, "UTC") : undefined;
  if (cron === undefined)
    problems.invalid("\"cron\" must be a five-field cron expression, for example \"0 3 * * *\".");
  else if (!cron.ok)
    problems.invalid(cron.error.message, cron.error.hint);
  if (typeof raw.timezone !== "string" || raw.timezone.trim() === "")
    problems.invalid("\"timezone\" must be an IANA time zone name, for example \"UTC\".");
  problems.oneOf(raw.overlap, overlapPolicies, "overlap");
  const id = problems.valid(idCandidate);

  const descriptor: ResourceDescriptorOf<"schedule"> = Object.freeze({
    protocol: descriptorProtocol,
    type: "resource",
    kind: "schedule",
    id,
    config: freezeJson({ cron: options.cron.trim().split(/\s+/).join(" "), timezone: options.timezone }),
    requirements: freezeJson({ overlap: options.overlap }),
    schemas: Object.freeze({})
  });

  return Object.freeze({
    [descriptorKey]: descriptor,
    kind: "schedule" as const,
    id: options.id,
    handle: <const HandlerId extends string>(registration: ScheduleHandlerOptions<HandlerId> & CheckResourceId<HandlerId>) => {
      const rawRegistration = requireOptions(registration, `handler of schedule "${id}"`);
      const registrationProblems = new DeclarationProblems(`handler "${String(rawRegistration.id)}" of schedule "${id}"`);
      const handlerIdCandidate = registrationProblems.identifier(rawRegistration.id, "handler id");
      if (typeof rawRegistration.handler !== "function")
        registrationProblems.invalid("\"handler\" must be a function.");
      const events = readEventOptions(rawRegistration.events, registrationProblems);
      const handlerId = registrationProblems.valid(handlerIdCandidate);

      /**
       * Runs the schedule handler for one scheduled run.
       *
       * @param _input - Unused; scheduled runs carry no payload.
       * @param context - The invocation context with the scheduled time.
       * @returns `undefined` once the handler has finished.
       */
      const invoke: HandlerInvoke<"schedule.tick"> = async (_input, context) => {
        const { scheduledTime, runId, trigger = "cron" } = context.metadata;
        await registration.handler({ scheduledTime, trigger, ...runId === undefined ? {} : { runId }, ...context.lineage === undefined ? {} : { lineage: context.lineage }, signal: context.signal, log: context.log });
        return undefined;
      };
      const handler: ScheduleHandler<Id, HandlerId> = Object.freeze({
        [descriptorKey]: Object.freeze({
          protocol: descriptorProtocol,
          type: "handler" as const,
          definition: freezeJson({
            id: handlerId,
            trigger: { kind: "schedule.tick" as const, resource: { kind: "schedule" as const, id }, options: {} },
            ...definedEntries({ events })
          }),
          schemas: Object.freeze({}),
          invoke
        }),
        trigger: "schedule.tick" as const,
        id: registration.id,
        resourceId: options.id
      });
      return handler;
    }
  });
}