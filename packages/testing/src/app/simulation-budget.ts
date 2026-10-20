import type {
  HandlerDescriptor,
  InvocationContext
} from "@holqa/core";

import type { InvocationRecord } from "@/app/invocation-records";

import {
  createDiagnostic,
  descriptorKey,
  diagnosticCodes,
  getHandlerDescriptor,
  HolqaError
} from "@holqa/core";

/**
 * A bound on how much work a test application runs, so that an event cycle
 * makes a test fail with an explanation instead of hanging or running
 * millions of invocations. Once the budget is spent, every further
 * invocation fails before its handler runs, which lets queued work drain
 * (retries back off and dead-letter) while the test reports the overrun.
 */
export class SimulationBudget {
  /** Invocations started so far. */
  private started = 0;
  /** Whether an invocation was refused. */
  private spent = false;

  /**
   * Creates a budget.
   *
   * @param maxInvocations - The most handler invocations the application may start.
   */
  constructor(private readonly maxInvocations: number) {}

  /** Whether the budget ran out. */
  get exceeded(): boolean {
    return this.spent;
  }

  /** How many invocations were started. */
  get count(): number {
    return this.started;
  }

  /**
   * Wraps a handler registration so that each invocation spends one unit.
   * Values that are not registrations are returned unchanged.
   *
   * @param registration - A handler module's export.
   * @returns A registration whose `invoke` fails once the budget is spent.
   */
  instrument(registration: unknown): unknown {
    const descriptor = getHandlerDescriptor(registration);
    if (descriptor === undefined)
      return registration;
    const original = descriptor.invoke as (input: unknown, context: InvocationContext<object>) => Promise<unknown>;
    /**
     * Spends one unit, then runs the handler.
     *
     * @param input - The invocation's input.
     * @param context - The invocation's context.
     * @returns What the handler returns.
     * @throws {HolqaError} `HOLQA_SIMULATION_BUDGET_EXCEEDED` once the budget is spent.
     */
    const invoke = async (input: unknown, context: InvocationContext<object>): Promise<unknown> => {
      this.started += 1;
      if (this.started > this.maxInvocations) {
        this.spent = true;
        throw new HolqaError(createDiagnostic({ code: diagnosticCodes.simulationBudgetExceeded, severity: "error", message: `The test application ran out of its simulation budget of ${this.maxInvocations} invocations.` }));
      }
      return original(input, context);
    };
    return Object.freeze({ [descriptorKey]: Object.freeze({ ...descriptor, invoke } as HandlerDescriptor) });
  }

  /**
   * Builds the error a test sees once the budget ran out: how much ran,
   * which handlers ran most, and the deepest causal chain, which usually
   * shows the cycle.
   *
   * @param records - Every finished invocation.
   * @returns The error.
   */
  failure(records: readonly InvocationRecord[]): HolqaError {
    const counts = new Map<string, number>();
    for (const record of records)
      counts.set(record.handlerId, (counts.get(record.handlerId) ?? 0) + 1);
    const busiest = [...counts].sort((left, right) => right[1] - left[1] || (left[0] < right[0] ? -1 : 1)).slice(0, 3);
    const deepest = records.reduce<InvocationRecord | undefined>((best, record) => best === undefined || record.depth > best.depth ? record : best, undefined);
    const chain = deepest === undefined ? [] : lineageOf(records, deepest.invocationId);
    const shown = chain.length > 8 ? [...chain.slice(0, 4).map(record => record.handlerId), "…", ...chain.slice(-3).map(record => record.handlerId)] : chain.map(record => record.handlerId);
    return new HolqaError(createDiagnostic({
      code: diagnosticCodes.simulationBudgetExceeded,
      severity: "error",
      message: `The test application ran more than ${this.maxInvocations} invocations, its simulation budget. Busiest handlers: ${busiest.map(([handler, count]) => `${handler} (${count})`).join(", ")}.${chain.length > 1 ? ` Deepest chain (${chain.length} invocations): ${shown.join(" → ")}.` : ""}`,
      hint: "An event cycle or an unbounded fan-out is the usual cause. Add a termination condition, set runtime event limits (events.maxDepth, events.maxEventsPerOperation), or raise maxInvocations if the work is expected.",
      details: { maxInvocations: this.maxInvocations, started: this.started, busiest: busiest.map(([handler, count]) => ({ handler, count })), chain: chain.map(record => record.handlerId) }
    }));
  }
}

/**
 * Follows causation from an invocation back to its root.
 *
 * @param records - Every finished invocation.
 * @param invocationId - Where the chain ends.
 * @returns The chain's invocations, root first; empty when the invocation is unknown.
 */
export function lineageOf(records: readonly InvocationRecord[], invocationId: string): InvocationRecord[] {
  // Every invocation has exactly one outcome record.
  const byId = new Map(records.map(record => [record.invocationId, record]));
  const chain: InvocationRecord[] = [];
  const seen = new Set<string>();
  let current = byId.get(invocationId);
  while (current !== undefined && !seen.has(current.invocationId)) {
    seen.add(current.invocationId);
    chain.unshift(current);
    current = current.causationId === undefined ? undefined : byId.get(current.causationId);
  }
  return chain;
}