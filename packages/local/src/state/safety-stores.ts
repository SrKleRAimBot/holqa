import type {
  IdempotencyClaim,
  IdempotencyStore,
  OperationBudgetStore
} from "@holqa/core";
import type { Database } from "bun:sqlite";

import type { Clock } from "@/clock";

/** Settings of the local safety stores. */
export interface SafetyStoreOptions {
  readonly database: Database;
  readonly clock: Clock;
  readonly createId: () => string;
}

/**
 * Creates the per-operation budget store of a local environment. Each
 * request runs in one SQLite transaction (`BEGIN IMMEDIATE` through
 * `database.transaction`), so every process that shares the state directory
 * sees one count and two requests can never both pass a limit only one fits.
 *
 * @param options - The state database and clock.
 * @returns The store the local binding provides as `operationBudgets`.
 */
export function createLocalOperationBudgets(options: SafetyStoreOptions): OperationBudgetStore {
  const { database, clock } = options;
  return Object.freeze<OperationBudgetStore>({
    consume: async ({ operationId, amount, limit }) => database.transaction(() => {
      const used = database.query<{ used: number }, [string]>("SELECT used FROM operation_budgets WHERE root_id = ?").get(operationId)?.used ?? 0;
      if (used + amount > limit)
        return Object.freeze({ allowed: false, used });
      database.query("INSERT INTO operation_budgets (root_id, used, updated_at) VALUES (?, ?, ?) ON CONFLICT (root_id) DO UPDATE SET used = excluded.used, updated_at = excluded.updated_at").run(operationId, used + amount, clock.now());
      return Object.freeze({ allowed: true, used: used + amount });
    }).immediate()
  });
}

/**
 * Creates the idempotency store of a local environment, kept in the state
 * database: durable across restarts and shared by every process that uses
 * the same state directory. Expired claims and records are replaced when
 * their key is claimed again.
 *
 * @param options - The state database, clock and token factory.
 * @returns The store the local binding provides as `idempotency`.
 */
export function createLocalIdempotencyStore(options: SafetyStoreOptions): IdempotencyStore {
  const { database, clock, createId } = options;
  return Object.freeze<IdempotencyStore>({
    begin: async (scope, key, { leaseMs }) => database.transaction((): IdempotencyClaim => {
      const now = clock.now();
      const row = database.query<{ state: "held" | "completed"; expires_at: number; completed_at: number | null }, [string, string]>("SELECT state, expires_at, completed_at FROM idempotency_keys WHERE scope = ? AND key = ?").get(scope, key);
      if (row !== null && row.expires_at > now) {
        return row.state === "completed"
          ? Object.freeze({ status: "completed" as const, completedAt: new Date(row.completed_at ?? row.expires_at).toISOString() })
          : Object.freeze({ status: "in-progress" as const, expiresAt: new Date(row.expires_at).toISOString() });
      }
      const token = createId();
      database.query("INSERT INTO idempotency_keys (scope, key, state, token, expires_at, completed_at) VALUES (?, ?, 'held', ?, ?, NULL) ON CONFLICT (scope, key) DO UPDATE SET state = 'held', token = excluded.token, expires_at = excluded.expires_at, completed_at = NULL").run(scope, key, token, now + Math.max(1, leaseMs));
      return Object.freeze({ status: "acquired" as const, token });
    }).immediate(),
    complete: async (scope, key, token, { retentionMs }) => {
      const now = clock.now();
      return database.query("UPDATE idempotency_keys SET state = 'completed', completed_at = ?, expires_at = ? WHERE scope = ? AND key = ? AND token = ? AND state = 'held' AND expires_at > ?").run(now, now + Math.max(1, retentionMs), scope, key, token, now).changes > 0;
    },
    release: async (scope, key, token) => database.query("DELETE FROM idempotency_keys WHERE scope = ? AND key = ? AND token = ? AND state = 'held' AND expires_at > ?").run(scope, key, token, clock.now()).changes > 0,
    extend: async (scope, key, token, { leaseMs }) => {
      const now = clock.now();
      return database.query("UPDATE idempotency_keys SET expires_at = ? WHERE scope = ? AND key = ? AND token = ? AND state = 'held' AND expires_at > ?").run(now + Math.max(1, leaseMs), scope, key, token, now).changes > 0;
    }
  });
}