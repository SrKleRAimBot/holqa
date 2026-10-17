import type {
  HandlerInvoke,
  InvocationLogger,
  ResourceDescriptorOf,
  ScheduleOverlap
} from "@holqa/core";

import type {
  HandlerRegistration,
  ResourceHandle
} from "@/resources/handle";
import type { CheckResourceId } from "@/types/checks";

import {
  descriptorKey,
  descriptorProtocol
} from "@holqa/core";

import {
  DeclarationProblems,
  freezeJson,
  requireOptions
} from "@/internal/declaration";

/** The overlap policies a schedule may require. */
const overlapPolicies: readonly ScheduleOverlap[] = ["skip", "allow"];

/** One cron field: digits, names, `*`, `?`, ranges, lists and steps. */
const cronField = /^[\w*?,/-]+$/;

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
  /** The time the run was scheduled for (ISO 8601), not the time it started. */
  readonly scheduledTime: string;
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
  if (typeof raw.cron !== "string" || raw.cron.trim().split(/\s+/).length !== 5 || !raw.cron.trim().split(/\s+/).every(field => cronField.test(field)))
    problems.invalid("\"cron\" must be a five-field cron expression, for example \"0 3 * * *\".");
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
      const handlerId = registrationProblems.valid(handlerIdCandidate);

      /**
       * Runs the schedule handler for one scheduled run.
       *
       * @param _input - Unused; scheduled runs carry no payload.
       * @param context - The invocation context with the scheduled time.
       * @returns `undefined` once the handler has finished.
       */
      const invoke: HandlerInvoke<"schedule.tick"> = async (_input, context) => {
        await registration.handler({ scheduledTime: context.metadata.scheduledTime, signal: context.signal, log: context.log });
        return undefined;
      };
      const handler: ScheduleHandler<Id, HandlerId> = Object.freeze({
        [descriptorKey]: Object.freeze({
          protocol: descriptorProtocol,
          type: "handler" as const,
          definition: freezeJson({
            id: handlerId,
            trigger: { kind: "schedule.tick" as const, resource: { kind: "schedule" as const, id }, options: {} }
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