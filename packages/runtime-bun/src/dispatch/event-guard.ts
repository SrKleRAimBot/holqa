import type {
  AppDescriptor,
  Diagnostic,
  DiagnosticCode,
  HandlerDefinition,
  InvocationLineage,
  ObjectEventType,
  OperationBudgetStore
} from "@holqa/core";

import {
  createDiagnostic,
  defaultEventLimits,
  diagnosticCodes,
  HolqaError
} from "@holqa/core";

/**
 * Limits on event-driven work. Depth and publication limits are enforced by
 * every runtime, in process. Event age needs a binding that reports when a
 * delivery was sent. A per-operation budget needs a binding with atomic,
 * shared accounting (`operationBudgets`); without one the runtime refuses to
 * start, because it could not keep the promise.
 */
export interface RuntimeEventLimits {
  /** The deepest event a handler receives, counted in hops from the root operation. Handlers may override it. Default 16. */
  readonly maxDepth?: number;
  /** The most events one invocation may publish. Handlers may override it. Default 1000. */
  readonly maxPublications?: number;
  /** Deliveries older than this, in milliseconds since they were sent, are not delivered. Default: no limit. */
  readonly maxEventAgeMs?: number;
  /** The most events all invocations of one root operation may publish together. Default: no limit. Requires `binding.operationBudgets`. */
  readonly maxEventsPerOperation?: number;
}

/** Why an event guard refused an event, as recorded on the invocation that tried to publish it. */
export interface EventGuardViolation {
  readonly code: DiagnosticCode;
  readonly message: string;
}

/** What a handler code operation is about to publish. */
export interface PendingEvent {
  readonly resourceId: string;
  readonly type: "queue.message" | ObjectEventType;
  /** For object events: the key written or deleted. */
  readonly key?: string;
}

/** The state of one running invocation the guard reads and updates. */
export interface GuardedInvocation {
  readonly invocationId: string;
  readonly handlerId: string;
  readonly lineage: InvocationLineage;
  /** Events counted against the publication limit so far. */
  publications: number;
  /** The first refusal, if any. Set once; an invocation that fails after a refusal ends terminally. */
  blocked?: EventGuardViolation;
}

/** A subscriber of an event: the handler and its prefix filter. */
interface Subscriber {
  readonly handlerId: string;
  readonly prefix?: string;
}

/**
 * Applies the runtime's event limits. It knows which handler each queue
 * message and object event reaches, so that only events that cause work are
 * counted and depth is checked against the receiving handler's limit.
 */
export class EventGuard {
  /** Resolved runtime-wide limits. */
  private readonly limits: Required<Pick<RuntimeEventLimits, "maxDepth" | "maxPublications">> & Pick<RuntimeEventLimits, "maxEventAgeMs" | "maxEventsPerOperation">;
  /** Per-handler overrides by handler identifier. */
  private readonly overrides: ReadonlyMap<string, { readonly maxDepth?: number; readonly maxPublications?: number }>;
  /** Subscribers by `<type>:<resource>`. */
  private readonly subscribers = new Map<string, Subscriber[]>();
  /** The binding's shared accounting, when the runtime runs on one. */
  private budgets: OperationBudgetStore | undefined;

  /**
   * Creates the guard for one runtime.
   *
   * @param app - The application.
   * @param handlers - The registered handlers' definitions.
   * @param limits - The runtime's validated limits.
   */
  constructor(app: AppDescriptor, handlers: Iterable<HandlerDefinition>, limits: RuntimeEventLimits = {}) {
    this.limits = { maxDepth: limits.maxDepth ?? defaultEventLimits.maxDepth, maxPublications: limits.maxPublications ?? defaultEventLimits.maxPublications, ...limits.maxEventAgeMs === undefined ? {} : { maxEventAgeMs: limits.maxEventAgeMs }, ...limits.maxEventsPerOperation === undefined ? {} : { maxEventsPerOperation: limits.maxEventsPerOperation } };
    const overrides = new Map<string, { readonly maxDepth?: number; readonly maxPublications?: number }>();
    const declared = new Set(app.resources.map(resource => resource.id as string));
    for (const definition of handlers) {
      const { maxDepth, maxPublications } = definition.events ?? {};
      overrides.set(definition.id, { ...isLimit(maxDepth) ? { maxDepth } : {}, ...isLimit(maxPublications) ? { maxPublications } : {} });
      const { trigger } = definition;
      if (!declared.has(trigger.resource.id))
        continue;
      const type = trigger.kind === "queue.message" ? "queue.message" : trigger.kind === "bucket.object-created" ? "object.created" : trigger.kind === "bucket.object-deleted" ? "object.deleted" : undefined;
      if (type === undefined)
        continue;
      const key = `${type}:${trigger.resource.id}`;
      const prefix = "prefix" in trigger.options ? trigger.options.prefix : undefined;
      this.subscribers.set(key, [...this.subscribers.get(key) ?? [], { handlerId: definition.id, ...prefix === undefined ? {} : { prefix } }]);
    }
    this.overrides = overrides;
  }

  /** Whether a per-operation budget is configured, which needs a binding with `operationBudgets`. */
  get needsOperationBudgets(): boolean {
    return this.limits.maxEventsPerOperation !== undefined;
  }

  /**
   * Connects the binding's shared accounting. Called when the runtime starts.
   *
   * @param budgets - The binding's store, if it has one.
   */
  attach(budgets: OperationBudgetStore | undefined): void {
    this.budgets = budgets;
  }

  /**
   * Returns the deepest event a handler receives.
   *
   * @param handlerId - The receiving handler.
   * @returns Its `maxDepth`, or the runtime's.
   */
  maxDepthOf(handlerId: string): number {
    return this.overrides.get(handlerId)?.maxDepth ?? this.limits.maxDepth;
  }

  /**
   * Admits an event that handler code is about to publish, or refuses it:
   * the invocation's publication limit, the receiving handlers' depth limits
   * and the operation's budget must all allow it. Events that no handler
   * receives are not limited. A refusal is recorded on the invocation and
   * thrown, so the operation never reaches the binding.
   *
   * @param invocation - The publishing invocation.
   * @param event - What it is about to publish.
   * @returns A promise that settles once the event is admitted.
   * @throws {HolqaError} `HOLQA_EVENT_PUBLICATION_LIMIT_EXCEEDED`, `HOLQA_EVENT_DEPTH_EXCEEDED` or `HOLQA_EXECUTION_BUDGET_EXCEEDED`.
   */
  async admit(invocation: GuardedInvocation, event: PendingEvent): Promise<void> {
    const receivers = (this.subscribers.get(`${event.type}:${event.resourceId}`) ?? []).filter(subscriber => subscriber.prefix === undefined || (event.key ?? "").startsWith(subscriber.prefix));
    if (receivers.length === 0)
      return;
    const subject = `${event.type === "queue.message" ? `A message to queue "${event.resourceId}"` : `An ${event.type} event of bucket "${event.resourceId}"`} from handler "${invocation.handlerId}"`;
    invocation.publications += 1;
    const publicationLimit = this.overrides.get(invocation.handlerId)?.maxPublications ?? this.limits.maxPublications;
    if (invocation.publications > publicationLimit)
      this.refuse(invocation, diagnosticCodes.eventPublicationLimitExceeded, `${subject} was refused: the invocation already published ${publicationLimit} events, its limit.`, "Publish fewer events per invocation (batch them into one message), or raise events.maxPublications on the handler.", { limit: publicationLimit });
    const depth = invocation.lineage.depth + 1;
    for (const receiver of receivers) {
      const limit = this.maxDepthOf(receiver.handlerId);
      if (depth > limit)
        this.refuse(invocation, diagnosticCodes.eventDepthExceeded, `${subject} was refused: it would reach handler "${receiver.handlerId}" at depth ${depth}, beyond its maxDepth of ${limit}.`, "A chain this deep usually means an event cycle. Add a termination condition, or raise events.maxDepth on the receiving handler if the chain is intended.", { depth, limit, receiver: receiver.handlerId });
    }
    const operationLimit = this.limits.maxEventsPerOperation;
    if (operationLimit === undefined)
      return;
    if (this.budgets === undefined)
      throw new HolqaError(createDiagnostic({ code: diagnosticCodes.bindingCapabilityUnsupported, severity: "error", message: "The binding provides no operation budget store, which the runtime's maxEventsPerOperation requires." }));
    const spent = await this.budgets.consume({ operationId: invocation.lineage.rootId, amount: 1, limit: operationLimit });
    if (!spent.allowed)
      this.refuse(invocation, diagnosticCodes.executionBudgetExceeded, `${subject} was refused: the operation "${invocation.lineage.rootId}" already published ${spent.used} events, its budget of ${operationLimit}.`, "The root operation fans out into too many events. Look for event cycles or unbounded fan-out, or raise the runtime's events.maxEventsPerOperation.", { limit: operationLimit, used: spent.used, rootId: invocation.lineage.rootId });
  }

  /**
   * Checks a delivery before its handler runs: its depth against the
   * handler's limit and its age against the runtime's.
   *
   * @param handlerId - The receiving handler.
   * @param lineage - The root, cause and depth the delivery carries.
   * @param sentAt - When it was sent, if the binding knows.
   * @param now - The current wall-clock time, in epoch milliseconds.
   * @returns The violation that refuses it, or `undefined` when it may run.
   */
  checkDelivery(handlerId: string, lineage: InvocationLineage, sentAt: string | undefined, now: number): EventGuardViolation | undefined {
    const limit = this.maxDepthOf(handlerId);
    if (lineage.depth > limit)
      return { code: diagnosticCodes.eventDepthExceeded, message: `The delivery is at depth ${lineage.depth} of operation "${lineage.rootId}", beyond the maxDepth of ${limit} of handler "${handlerId}"; it is not delivered.` };
    const maxAge = this.limits.maxEventAgeMs;
    const sent = sentAt === undefined ? Number.NaN : Date.parse(sentAt);
    if (maxAge !== undefined && Number.isFinite(sent) && now - sent > maxAge)
      return { code: diagnosticCodes.eventAgeExceeded, message: `The delivery was sent ${now - sent} ms ago, longer than the maxEventAgeMs of ${maxAge}; it is not delivered.` };
    return undefined;
  }

  /**
   * Records a refusal on the invocation and throws it.
   *
   * @param invocation - The publishing invocation.
   * @param code - Which limit refused the event.
   * @param message - Why.
   * @param hint - What to do.
   * @param details - Machine-readable limits.
   * @throws {HolqaError} Always.
   */
  private refuse(invocation: GuardedInvocation, code: DiagnosticCode, message: string, hint: string, details: Diagnostic["details"] & object): never {
    invocation.blocked ??= { code, message };
    throw new HolqaError(createDiagnostic({ code, severity: "error", message, hint, details: { handler: invocation.handlerId, ...details } }));
  }
}

/**
 * Reports whether a declared limit is usable.
 *
 * @param value - A handler's declared limit.
 * @returns `true` for positive safe integers.
 */
function isLimit(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

/**
 * Validates runtime event limits.
 *
 * @param limits - The configured limits, unvalidated.
 * @returns One problem per malformed limit.
 */
export function eventLimitProblems(limits: unknown): string[] {
  if (limits === undefined)
    return [];
  if (typeof limits !== "object" || limits === null)
    return ["\"events\" must be an object."];
  const problems: string[] = [];
  for (const name of ["maxDepth", "maxPublications", "maxEventAgeMs", "maxEventsPerOperation"] as const) {
    const value = (limits as Readonly<Record<string, unknown>>)[name];
    if (value !== undefined && !isLimit(value))
      problems.push(`"events.${name}" must be a positive integer.`);
  }
  return problems;
}