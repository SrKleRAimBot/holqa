import type {
  HandlerDefinition,
  OperationBudgetStore
} from "@holqa/core";

import type { GuardedInvocation } from "@/dispatch/event-guard";

import {
  diagnosticsOf,
  getAppDescriptor
} from "@holqa/core";
import {
  application,
  id,
  queueResource
} from "@test/support/descriptors";
import {
  describe,
  expect,
  it
} from "bun:test";

import {
  EventGuard,
  eventLimitProblems
} from "@/dispatch/event-guard";

/** The application: a queue and a bucket. */
const app = getAppDescriptor(application([queueResource("jobs"), { protocol: 1, type: "resource", kind: "bucket", id: id("files"), config: {}, requirements: { access: "private" }, schemas: {} }]))!;

/** The handlers: a consumer of `jobs` and a created-object handler on `files/incoming/`. */
const handlers: HandlerDefinition[] = [
  { id: id("jobs.run"), trigger: { kind: "queue.message", resource: { kind: "queue", id: id("jobs") }, options: {} }, events: { maxDepth: 3 } },
  { id: id("files.created"), trigger: { kind: "bucket.object-created", resource: { kind: "bucket", id: id("files") }, options: { prefix: "incoming/" } }, events: { maxPublications: 2 } }
];

/**
 * Creates the state of a running invocation.
 *
 * @param handlerId - The publishing handler.
 * @param depth - Its depth.
 * @returns A fresh invocation state with no publications.
 */
function invocation(handlerId: string, depth = 0): GuardedInvocation {
  return { invocationId: "inv-1", handlerId, lineage: { correlationId: "c", rootId: "root-1", depth }, publications: 0 };
}

/**
 * Admits an event and returns the code it was refused with.
 *
 * @param guard - The guard under test.
 * @param active - The publishing invocation.
 * @param event - The resource, event type and key.
 * @returns The refusal code, or `undefined` when admitted.
 */
async function refusal(guard: EventGuard, active: GuardedInvocation, event: Parameters<EventGuard["admit"]>[1]): Promise<string | undefined> {
  try {
    await guard.admit(active, event);
    return undefined;
  } catch (error) {
    return diagnosticsOf(error)[0]?.code;
  }
}

describe("EventGuard", () => {
  it("refuses events deeper than the receiving handler's maxDepth and records the refusal", async () => {
    const guard = new EventGuard(app, handlers);
    expect(await refusal(guard, invocation("files.created", 2), { resourceId: "jobs", type: "queue.message" })).toBeUndefined();
    const deep = invocation("files.created", 3);
    expect(await refusal(guard, deep, { resourceId: "jobs", type: "queue.message" })).toBe("HOLQA_EVENT_DEPTH_EXCEEDED");
    expect(deep.blocked?.code).toBe("HOLQA_EVENT_DEPTH_EXCEEDED");
  });

  it("limits publications per invocation and counts only events a handler receives", async () => {
    const guard = new EventGuard(app, handlers);
    const active = invocation("files.created");
    expect(await refusal(guard, active, { resourceId: "files", type: "object.created", key: "processed/a" })).toBeUndefined();
    expect(await refusal(guard, active, { resourceId: "files", type: "object.deleted", key: "incoming/a" })).toBeUndefined();
    expect(active.publications).toBe(0);
    expect(await refusal(guard, active, { resourceId: "jobs", type: "queue.message" })).toBeUndefined();
    expect(await refusal(guard, active, { resourceId: "files", type: "object.created", key: "incoming/b" })).toBeUndefined();
    expect(await refusal(guard, active, { resourceId: "jobs", type: "queue.message" })).toBe("HOLQA_EVENT_PUBLICATION_LIMIT_EXCEEDED");
  });

  it("spends the root operation's budget through the binding's store", async () => {
    const used = new Map<string, number>();
    const budgets: OperationBudgetStore = {
      consume: async ({ operationId, amount, limit }) => {
        const next = (used.get(operationId) ?? 0) + amount;
        if (next > limit)
          return { allowed: false, used: used.get(operationId) ?? 0 };
        used.set(operationId, next);
        return { allowed: true, used: next };
      }
    };
    const guard = new EventGuard(app, handlers, { maxEventsPerOperation: 2 });
    expect(guard.needsOperationBudgets).toBe(true);
    guard.attach(budgets);
    const first = invocation("jobs.run");
    const second = { ...invocation("jobs.run"), invocationId: "inv-2" };
    expect(await refusal(guard, first, { resourceId: "jobs", type: "queue.message" })).toBeUndefined();
    expect(await refusal(guard, second, { resourceId: "jobs", type: "queue.message" })).toBeUndefined();
    expect(await refusal(guard, first, { resourceId: "jobs", type: "queue.message" })).toBe("HOLQA_EXECUTION_BUDGET_EXCEEDED");
    const independent = { ...invocation("jobs.run"), lineage: { correlationId: "c", rootId: "root-2", depth: 0 } };
    expect(await refusal(guard, independent, { resourceId: "jobs", type: "queue.message" })).toBeUndefined();
  });

  it("checks a delivery's depth and age before its handler runs", () => {
    const guard = new EventGuard(app, handlers, { maxEventAgeMs: 1_000 });
    const now = Date.parse("2026-01-01T00:00:10.000Z");
    expect(guard.checkDelivery("jobs.run", { correlationId: "c", rootId: "r", depth: 4 }, undefined, now)?.code).toBe("HOLQA_EVENT_DEPTH_EXCEEDED");
    expect(guard.checkDelivery("jobs.run", { correlationId: "c", rootId: "r", depth: 1 }, "2026-01-01T00:00:08.000Z", now)?.code).toBe("HOLQA_EVENT_AGE_EXCEEDED");
    expect(guard.checkDelivery("jobs.run", { correlationId: "c", rootId: "r", depth: 1 }, "2026-01-01T00:00:09.500Z", now)).toBeUndefined();
    expect(guard.checkDelivery("files.created", { correlationId: "c", rootId: "r", depth: 16 }, undefined, now)).toBeUndefined();
    expect(guard.checkDelivery("files.created", { correlationId: "c", rootId: "r", depth: 17 }, undefined, now)?.code).toBe("HOLQA_EVENT_DEPTH_EXCEEDED");
  });

  it("validates runtime limits", () => {
    expect(eventLimitProblems(undefined)).toEqual([]);
    expect(eventLimitProblems({ maxDepth: 0, maxPublications: 1.5, maxEventAgeMs: -1, maxEventsPerOperation: 10 })).toHaveLength(3);
  });
});