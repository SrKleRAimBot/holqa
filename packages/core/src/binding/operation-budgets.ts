/** One request to spend part of a root operation's budget. */
export interface OperationBudgetRequest {
  /** The root operation (`InvocationLineage.rootId`) the events belong to. */
  readonly operationId: string;
  /** How many units to spend; at least 1. */
  readonly amount: number;
  /** The most units the operation may spend in total. */
  readonly limit: number;
}

/** The answer to an {@link OperationBudgetRequest}. */
export interface OperationBudgetResult {
  /** Whether the units were spent. When `false`, nothing changed. */
  readonly allowed: boolean;
  /** Units the operation has spent, including this request when it was allowed. */
  readonly used: number;
}

/**
 * Aggregate accounting of the events every invocation of one root operation
 * published, across all of the runtime's workers and processes. A runtime
 * enforces a per-operation budget (`events.maxEventsPerOperation`) only with
 * a binding that provides this store, and refuses to start otherwise.
 *
 * Implementations must be atomic across every process that serves the
 * application: two concurrent requests must never both be allowed when only
 * one fits. A binding whose infrastructure cannot guarantee that must not
 * provide this store, because a budget it cannot enforce would be a promise
 * it does not keep.
 */
export interface OperationBudgetStore {
  /**
   * Spends `amount` units of an operation's budget when the total stays at or
   * below `limit`; otherwise spends nothing.
   */
  readonly consume: (request: OperationBudgetRequest) => Promise<OperationBudgetResult>;
}