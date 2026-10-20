import type { ResourceReference } from "@/resources/resource-descriptor";

import { diagnosticCodes } from "@/diagnostics/codes";
import { isResourceId } from "@/identity/resource-id";
import { isResourceKind } from "@/resources/kinds";

/** The longest idempotency claim lease, in seconds (one day). */
export const maxIdempotencyLeaseSeconds = 86_400;

/** The longest idempotency retention, in seconds (one year). */
export const maxIdempotencyRetentionSeconds = 31_536_000;

/** The longest cycle justification, in characters. */
export const maxCycleJustificationLength = 500;

/**
 * The event limits a runtime applies when neither it nor a handler sets
 * them: events at most 16 hops from their root operation, and at most 1000
 * published events per invocation. Event age and per-operation budgets have
 * no default.
 */
export const defaultEventLimits = Object.freeze({ maxDepth: 16, maxPublications: 1000 });

/**
 * Codes of event guards. A delivery refused or stopped by one of them is
 * settled at once (dead-lettered or discarded) instead of being retried,
 * because a retry would run into the same limit.
 */
const terminalEventCodes: ReadonlySet<string> = new Set([
  diagnosticCodes.eventDepthExceeded,
  diagnosticCodes.eventPublicationLimitExceeded,
  diagnosticCodes.eventAgeExceeded,
  diagnosticCodes.executionBudgetExceeded
]);

/**
 * Reports whether a diagnostic code is an event guard's, whose deliveries end
 * terminally instead of being retried.
 *
 * @param code - A diagnostic code, for example from a delivery failure.
 * @returns `true` for `HOLQA_EVENT_DEPTH_EXCEEDED`, `HOLQA_EVENT_PUBLICATION_LIMIT_EXCEEDED`, `HOLQA_EVENT_AGE_EXCEEDED` and `HOLQA_EXECUTION_BUDGET_EXCEEDED`.
 */
export function isEventGuardCode(code: string): boolean {
  return terminalEventCodes.has(code);
}

/**
 * Declares that a handler takes part in an intentional event cycle, for
 * example a consumer that requeues work until it reaches a terminal state.
 * Cycles through the handler are reported as allowed instead of warned
 * about; runtime limits (depth, publications, operation budgets) still apply.
 */
export interface HandlerCycleAllowance {
  /** Why the cycle terminates: a non-empty sentence of at most 500 characters, shown in inspection output. */
  readonly justification: string;
}

/**
 * The event safety policy a handler declares, as JSON data in its definition.
 * Every field is optional; absent limits fall back to the runtime's.
 */
export interface HandlerEventPolicy {
  /**
   * Resources the handler publishes to (sends to, writes to or deletes
   * from), for code that static analysis cannot follow. Declared targets are
   * treated as known publications, in addition to the ones analysis finds.
   */
  readonly publishes?: readonly ResourceReference[];
  /** Permits cycles through this handler; see {@link HandlerCycleAllowance}. */
  readonly cycle?: HandlerCycleAllowance;
  /** The most events one invocation may publish. Overrides the runtime's `events.maxPublications`. */
  readonly maxPublications?: number;
  /** The deepest event this handler receives: events deeper than this are not delivered to it. Overrides the runtime's `events.maxDepth`. */
  readonly maxDepth?: number;
}

/** How a handler derives its idempotency key. */
export type IdempotencyKeySource = "delivery" | "custom";

/**
 * The duplicate-suppression policy a queue consumer or object event handler
 * declares, as JSON data in its definition. The runtime binding must provide
 * an idempotency store.
 */
export interface HandlerIdempotencyPolicy {
  /** `delivery`: the message or event identifier; `custom`: a key function the handler declares. */
  readonly key: IdempotencyKeySource;
  /** How long completed keys are remembered, in seconds. */
  readonly retentionSeconds: number;
  /** How long a claim lasts without being renewed, in seconds. The claim is renewed while the handler runs, so a crashed attempt blocks its key for at most this long. */
  readonly leaseSeconds: number;
}

/**
 * Checks an untrusted event policy, as read from a handler definition.
 *
 * @param value - The definition's `events` field.
 * @returns The problems found, as sentences without a subject; empty when the policy is absent or valid.
 */
export function eventPolicyProblems(value: unknown): string[] {
  if (value === undefined)
    return [];
  if (!isRecord(value))
    return ["\"events\" must be an object."];
  const problems: string[] = [];
  const { publishes, cycle, maxPublications, maxDepth } = value;
  for (const key of Object.keys(value)) {
    if (!["publishes", "cycle", "maxPublications", "maxDepth"].includes(key))
      problems.push(`"events" has the unknown setting "${key}".`);
  }
  if (publishes !== undefined) {
    if (!Array.isArray(publishes))
      problems.push("\"events.publishes\" must be a list of resources.");
    else if (!publishes.every(entry => isResourceReference(entry)))
      problems.push("\"events.publishes\" must list resource handles declared with the SDK.");
  }
  if (cycle !== undefined) {
    const { justification } = isRecord(cycle) ? cycle : { justification: undefined };
    if (typeof justification !== "string" || justification.trim() === "" || justification.length > maxCycleJustificationLength)
      problems.push(`"events.cycle.justification" must explain in at most ${maxCycleJustificationLength} characters why the cycle terminates.`);
  }
  for (const [name, limit] of [["maxPublications", maxPublications], ["maxDepth", maxDepth]] as const) {
    if (limit !== undefined && !(typeof limit === "number" && Number.isSafeInteger(limit) && limit >= 1))
      problems.push(`"events.${name}" must be a positive integer.`);
  }
  return problems;
}

/**
 * Checks an untrusted idempotency policy, as read from a handler definition.
 *
 * @param value - The definition's `idempotency` field.
 * @returns The problems found; empty when the policy is absent or valid.
 */
export function idempotencyPolicyProblems(value: unknown): string[] {
  if (value === undefined)
    return [];
  if (!isRecord(value))
    return ["\"idempotency\" must be an object."];
  const problems: string[] = [];
  const { key } = value;
  if (key !== "delivery" && key !== "custom")
    problems.push("\"idempotency.key\" must be \"delivery\" or \"custom\".");
  for (const [name, maximum] of [["retentionSeconds", maxIdempotencyRetentionSeconds], ["leaseSeconds", maxIdempotencyLeaseSeconds]] as const) {
    const seconds = value[name];
    if (!(typeof seconds === "number" && Number.isSafeInteger(seconds) && seconds >= 1 && seconds <= maximum))
      problems.push(`"idempotency.${name}" must be a whole number of seconds from 1 to ${maximum}.`);
  }
  return problems;
}

/**
 * Reports whether a value is a resource reference with a registered kind and a valid identifier.
 *
 * @param value - A candidate entry of `events.publishes`.
 * @returns `true` for `{ kind, id }` references.
 */
function isResourceReference(value: unknown): boolean {
  if (!isRecord(value))
    return false;
  const { kind, id } = value;
  return isResourceKind(kind) && isResourceId(id);
}

/**
 * Reports whether a value is a plain record.
 *
 * @param value - The value to inspect.
 * @returns `true` for non-null objects that are not arrays.
 */
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}