/**
 * The result of claiming an idempotency key, discriminated by `status`:
 *
 * - `acquired`: nobody processed the key yet; the caller now holds it and must
 *   `complete` or `release` it with `token`;
 * - `completed`: the key was processed successfully before and is still retained;
 * - `in-progress`: another holder claimed it and its lease has not ended.
 */
export type IdempotencyClaim
  = | { readonly status: "acquired"; readonly token: string }
    | { readonly status: "completed"; readonly completedAt: string }
    | { readonly status: "in-progress"; readonly expiresAt: string };

/** Settings of {@link IdempotencyStore.begin}. */
export interface IdempotencyBeginOptions {
  /** How long the claim lasts without `complete` or `release`, in milliseconds. A holder that crashes loses its claim when it ends. */
  readonly leaseMs: number;
}

/** Settings of {@link IdempotencyStore.extend}. */
export interface IdempotencyExtendOptions {
  /** The claim's new lease, in milliseconds from now. */
  readonly leaseMs: number;
}

/** Settings of {@link IdempotencyStore.complete}. */
export interface IdempotencyCompleteOptions {
  /** How long the completed record is kept, in milliseconds. Duplicates that arrive later are processed again. */
  readonly retentionMs: number;
}

/**
 * A deduplication store: records which keys within a scope (for example one
 * handler) were processed, so that duplicate deliveries can be recognized.
 *
 * A record says that processing *finished*; it is not transactional with the
 * processing's side effects. When a holder performs a side effect (a payment,
 * an email, a database update) and fails before `complete`, the key is
 * processed again. Holqa therefore offers duplicate *suppression* for
 * deliveries, never exactly-once side effects; side effects that must not
 * repeat need their own idempotency (for example a key passed to the payment
 * service, or a unique constraint in the same database transaction).
 */
export interface IdempotencyStore {
  /** Claims a key, or reports that it is completed or held by someone else. */
  readonly begin: (scope: string, key: string, options: IdempotencyBeginOptions) => Promise<IdempotencyClaim>;
  /** Marks a held key as completed. Resolves to `false` when the claim was lost (its lease ended and someone else claimed the key). */
  readonly complete: (scope: string, key: string, token: string, options: IdempotencyCompleteOptions) => Promise<boolean>;
  /** Gives a held key up, so the next delivery processes it. Resolves to `false` when the claim was already lost. */
  readonly release: (scope: string, key: string, token: string) => Promise<boolean>;
  /**
   * Renews a held claim, so a long-running holder keeps its key while a
   * crashed one loses it after one short lease. Resolves to `false` when the
   * claim was already lost.
   */
  readonly extend: (scope: string, key: string, token: string, options: IdempotencyExtendOptions) => Promise<boolean>;
}

/**
 * Builds an idempotency key from its parts in Holqa's conventional form:
 * every part percent-encoded and joined with `:`, so that parts containing
 * `:` never collide (`["a:b", "c"]` and `["a", "b:c"]` differ).
 *
 * Conventions: queue consumers key on the `messageId`, object event handlers
 * on the event `id`; keys derived from business data (an order number) also
 * catch duplicates that a producer sent twice as two messages.
 *
 * @param parts - The key's parts, at least one. Numbers must be safe integers.
 * @returns The parts, percent-encoded and joined with `:`.
 * @throws {RangeError} When there are no parts, or a part is an empty string or a number that is not a safe integer.
 *
 * @example
 * ```ts
 * createIdempotencyKey(["order", message.orderId, "receipt"]); // "order:A%3A1:receipt"
 * ```
 */
export function createIdempotencyKey(parts: readonly (string | number)[]): string {
  if (parts.length === 0)
    throw new RangeError("An idempotency key needs at least one part.");
  return parts.map((part) => {
    if (typeof part === "number" ? !Number.isSafeInteger(part) : typeof part !== "string" || part === "")
      throw new RangeError(`An idempotency key part must be a non-empty string or a safe integer, not ${JSON.stringify(part)}.`);
    return encodeURIComponent(String(part));
  }).join(":");
}

/** Settings of {@link createMemoryIdempotencyStore}. */
export interface MemoryIdempotencyStoreOptions {
  /** The clock, in epoch milliseconds. Defaults to `Date.now`. */
  readonly now?: () => number;
  /** Creates claim tokens. Defaults to `crypto.randomUUID`. */
  readonly createToken?: () => string;
}

/** One record of the memory store. */
type MemoryRecord
  = | { readonly state: "held"; readonly token: string; /** When the lease ends. */ readonly expiresAt: number }
    | { readonly state: "completed"; readonly token: string; /** When the record is forgotten. */ readonly expiresAt: number; readonly completedAt: number };

/**
 * Creates an idempotency store that keeps its records in memory. It is
 * correct only within one process: separate processes, or a restarted
 * process, do not see each other's records. Use it for tests and
 * single-process deployments; bindings provide durable stores.
 *
 * @param options - The clock and token factory.
 * @returns A store whose records live as long as the returned object.
 */
export function createMemoryIdempotencyStore(options: MemoryIdempotencyStoreOptions = {}): IdempotencyStore {
  const now = options.now ?? (() => Date.now());
  const createToken = options.createToken ?? (() => crypto.randomUUID());
  const records = new Map<string, MemoryRecord>();
  /**
   * Builds the map key of a scoped key.
   *
   * @param scope - The scope, for example a handler identifier.
   * @param key - The idempotency key within the scope.
   * @returns A collision-free combination.
   */
  const slot = (scope: string, key: string): string => createIdempotencyKey([scope, key]);
  /**
   * Returns the live record of a key, forgetting it once it expired.
   *
   * @param id - The map key.
   * @returns The record, or `undefined`.
   */
  const live = (id: string): MemoryRecord | undefined => {
    const record = records.get(id);
    if (record !== undefined && record.expiresAt <= now()) {
      records.delete(id);
      return undefined;
    }
    return record;
  };
  return Object.freeze<IdempotencyStore>({
    begin: async (scope, key, { leaseMs }) => {
      const id = slot(scope, key);
      const record = live(id);
      if (record?.state === "completed")
        return Object.freeze({ status: "completed" as const, completedAt: new Date(record.completedAt).toISOString() });
      if (record?.state === "held")
        return Object.freeze({ status: "in-progress" as const, expiresAt: new Date(record.expiresAt).toISOString() });
      const token = createToken();
      records.set(id, { state: "held", token, expiresAt: now() + Math.max(1, leaseMs) });
      return Object.freeze({ status: "acquired" as const, token });
    },
    complete: async (scope, key, token, { retentionMs }) => {
      const id = slot(scope, key);
      const record = live(id);
      if (record?.state !== "held" || record.token !== token)
        return false;
      const completedAt = now();
      records.set(id, { state: "completed", token, expiresAt: completedAt + Math.max(1, retentionMs), completedAt });
      return true;
    },
    release: async (scope, key, token) => {
      const id = slot(scope, key);
      const record = live(id);
      if (record?.state !== "held" || record.token !== token)
        return false;
      records.delete(id);
      return true;
    },
    extend: async (scope, key, token, { leaseMs }) => {
      const id = slot(scope, key);
      const record = live(id);
      if (record?.state !== "held" || record.token !== token)
        return false;
      records.set(id, { state: "held", token, expiresAt: now() + Math.max(1, leaseMs) });
      return true;
    }
  });
}