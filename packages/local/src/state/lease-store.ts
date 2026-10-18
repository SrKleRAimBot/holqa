import type {
  DeliveryFailure,
  DeliverySource,
  LeasedDelivery,
  ReceiveRequest
} from "@holqa/core";
import type { Database } from "bun:sqlite";

import type { Clock } from "@/clock";

import { diagnosticCodes } from "@holqa/core";

/** Where a delivery is in its life. */
export type DeliveryState = "ready" | "leased" | "acknowledged" | "dead";

/** The failure recorded with a retried or dead-lettered delivery. */
export interface DeliveryError {
  readonly code: string;
  readonly message: string;
  readonly invocationId?: string;
}

/** One stored delivery, as inspection reports it. */
export interface StoredDelivery {
  readonly seq: number;
  readonly id: string;
  readonly body: string;
  readonly state: DeliveryState;
  readonly attempts: number;
  readonly visibleAt: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly lastError?: DeliveryError;
}

/** A row of the `deliveries` table. */
interface DeliveryRow {
  readonly seq: number;
  readonly delivery_id: string;
  readonly body: string;
  readonly state: DeliveryState;
  readonly attempts: number;
  readonly visible_at: number;
  readonly lease_token: string | null;
  readonly created_at: number;
  readonly updated_at: number;
  readonly last_error_code: string | null;
  readonly last_error_message: string | null;
  readonly last_invocation_id: string | null;
}

/** Settings of a {@link LeaseStore}. */
export interface LeaseStoreOptions {
  readonly database: Database;
  readonly clock: Clock;
  readonly createId: () => string;
  /** How often a waiting receiver checks for deliveries added by another process, in milliseconds. */
  readonly pollIntervalMs: number;
  /** How long acknowledged deliveries are kept for inspection, in milliseconds. */
  readonly retentionMs: number;
}

/**
 * Durable, leased deliveries grouped by channel (one channel per queue, and
 * one per object event subscription). Leasing is what makes delivery at least
 * once: a receiver that crashes or stalls loses its lease when it expires,
 * and the delivery becomes due again with a higher attempt count.
 *
 * Ordering is best effort (oldest due first); it is not guaranteed, because
 * retries, delays and expired leases reorder deliveries, as they do in
 * production queues.
 */
export class LeaseStore {
  /** Settings. */
  private readonly options: LeaseStoreOptions;
  /** Wake-up functions of receivers waiting on each channel. */
  private readonly waiters = new Map<string, Set<() => void>>();
  /** Channels a runtime currently receives from, with their receiver counts. */
  private readonly active = new Map<string, number>();

  /**
   * Creates a store over an open state database.
   *
   * @param options - The database, clock and timing settings.
   */
  constructor(options: LeaseStoreOptions) {
    this.options = options;
  }

  /**
   * Adds a delivery to a channel.
   *
   * @param channel - The channel, for example `queue:orders`.
   * @param id - The delivery's identity (message or event identifier).
   * @param body - The JSON text delivered.
   * @param delayMs - How long until it is due.
   */
  add(channel: string, id: string, body: string, delayMs = 0): void {
    const now = this.options.clock.now();
    this.options.database.query("INSERT INTO deliveries (channel, delivery_id, body, state, attempts, visible_at, created_at, updated_at) VALUES (?, ?, ?, 'ready', 0, ?, ?, ?)")
      .run(channel, id, body, now + Math.max(0, delayMs), now, now);
  }

  /**
   * Wakes the receivers of a channel; call it after adding or releasing deliveries.
   *
   * @param channel - The channel name, for example `queue:orders`.
   */
  notify(channel: string): void {
    for (const wake of [...this.waiters.get(channel) ?? []])
      wake();
  }

  /**
   * Removes acknowledged deliveries older than the retention period.
   */
  prune(): void {
    this.options.database.query("DELETE FROM deliveries WHERE state = 'acknowledged' AND updated_at < ?").run(this.options.clock.now() - this.options.retentionMs);
  }

  /**
   * Creates the delivery source of one channel.
   *
   * @param channel - The channel name, for example `queue:orders`.
   * @param decode - Parses a stored body; the runtime validates the result again.
   * @returns A source that leases, settles and waits for the channel's deliveries.
   */
  source<Body>(channel: string, decode: (body: string) => Body): DeliverySource<Body> {
    this.active.set(channel, (this.active.get(channel) ?? 0) + 1);
    return Object.freeze({
      receive: async (request: ReceiveRequest) => this.receive(channel, request, decode),
      acknowledge: async (receipt: string) => this.settle(receipt, "UPDATE deliveries SET state = 'acknowledged', lease_token = NULL, updated_at = $now WHERE seq = $seq AND lease_token = $token AND state = 'leased'", {}),
      retry: async (receipt: string, delayMs: number, failure: DeliveryFailure) => {
        const settled = this.settle(receipt, "UPDATE deliveries SET state = 'ready', lease_token = NULL, visible_at = $now + $delay, updated_at = $now, last_error_code = $code, last_error_message = $message, last_invocation_id = $invocation WHERE seq = $seq AND lease_token = $token AND state = 'leased'", { delay: Math.max(0, delayMs), ...failureFields(failure) });
        if (settled)
          this.notify(channel);
        return settled;
      },
      deadLetter: async (receipt: string, failure: DeliveryFailure) => this.settle(receipt, "UPDATE deliveries SET state = 'dead', lease_token = NULL, updated_at = $now, last_error_code = $code, last_error_message = $message, last_invocation_id = $invocation WHERE seq = $seq AND lease_token = $token AND state = 'leased'", failureFields(failure)),
      extend: async (receipt: string, leaseMs: number) => this.settle(receipt, "UPDATE deliveries SET visible_at = $now + $lease, updated_at = $now WHERE seq = $seq AND lease_token = $token AND state = 'leased'", { lease: Math.max(1, leaseMs) }),
      discard: async (receipt: string) => this.settle(receipt, "DELETE FROM deliveries WHERE seq = $seq AND lease_token = $token AND state = 'leased'", {}),
      wait: async (signal: AbortSignal) => this.wait(channel, signal)
    });
  }

  /**
   * Lists a channel's deliveries, oldest first.
   *
   * @param channel - The channel name, for example `queue:orders`.
   * @param states - Only these states; all when absent.
   * @returns The deliveries.
   */
  list(channel: string, states?: readonly DeliveryState[]): StoredDelivery[] {
    const rows = this.options.database.query<DeliveryRow, [string]>("SELECT * FROM deliveries WHERE channel = ? ORDER BY seq").all(channel);
    return rows.filter(row => states === undefined || states.includes(row.state)).map(toStoredDelivery);
  }

  /**
   * Makes dead-lettered deliveries due again with a fresh attempt count.
   *
   * @param channel - The channel name, for example `queue:orders`.
   * @param id - Only the deliveries with this identity; all dead deliveries when absent.
   * @returns How many deliveries were redriven.
   */
  redrive(channel: string, id?: string): number {
    const now = this.options.clock.now();
    const { changes } = id === undefined
      ? this.options.database.query("UPDATE deliveries SET state = 'ready', attempts = 0, visible_at = ?, updated_at = ? WHERE channel = ? AND state = 'dead'").run(now, now, channel)
      : this.options.database.query("UPDATE deliveries SET state = 'ready', attempts = 0, visible_at = ?, updated_at = ? WHERE channel = ? AND state = 'dead' AND delivery_id = ?").run(now, now, channel, id);
    if (changes > 0)
      this.notify(channel);
    return changes;
  }

  /**
   * Adds another copy of a known delivery, as an at-least-once transport may
   * deliver it twice. The copy has the same identity.
   *
   * @param channel - The channel name, for example `queue:orders`.
   * @param id - The delivery's identity.
   * @returns `true` when a delivery with that identity was found and copied.
   */
  duplicate(channel: string, id: string): boolean {
    const row = this.options.database.query<{ body: string }, [string, string]>("SELECT body FROM deliveries WHERE channel = ? AND delivery_id = ? ORDER BY seq LIMIT 1").get(channel, id);
    if (row === null)
      return false;
    this.add(channel, id, row.body);
    this.notify(channel);
    return true;
  }

  /**
   * Deletes every delivery of a channel that is not leased.
   *
   * @param channel - The channel name, for example `queue:orders`.
   * @returns How many deliveries were deleted.
   */
  purge(channel: string): number {
    return this.options.database.query("DELETE FROM deliveries WHERE channel = ? AND state != 'leased'").run(channel).changes;
  }

  /**
   * Reports whether any channel a runtime receives from has deliveries that
   * are due or leased: work that will happen without moving the clock.
   *
   * @returns The names of channels with due or leased deliveries.
   */
  busyChannels(): string[] {
    const now = this.options.clock.now();
    return [...this.active.keys()].filter(channel => this.options.database.query<{ busy: number }, [string, number]>(
      "SELECT EXISTS (SELECT 1 FROM deliveries WHERE channel = ? AND (state = 'leased' OR (state = 'ready' AND visible_at <= ?))) AS busy"
    ).get(channel, now)?.busy === 1);
  }

  /**
   * Leases due deliveries in one transaction, so concurrent receivers never
   * get the same lease. A stored body that cannot be decoded is dead-lettered
   * with `HOLQA_PAYLOAD_MALFORMED` instead of failing the whole receive.
   *
   * @param channel - The channel name, for example `queue:orders`.
   * @param request - How many, and for how long.
   * @param decode - Parses stored bodies.
   * @returns The leased deliveries.
   */
  private receive<Body>(channel: string, request: ReceiveRequest, decode: (body: string) => Body): Array<LeasedDelivery<Body>> {
    const { database, clock, createId } = this.options;
    const leased = database.transaction(() => {
      const now = clock.now();
      const rows = database.query<DeliveryRow, [string, number, number]>(
        "SELECT * FROM deliveries WHERE channel = ? AND state IN ('ready', 'leased') AND visible_at <= ? ORDER BY visible_at, seq LIMIT ?"
      ).all(channel, now, Math.max(1, Math.floor(request.max)));
      return rows.flatMap((row) => {
        let body: Body;
        try {
          body = decode(row.body);
        } catch (error) {
          database.query("UPDATE deliveries SET state = 'dead', attempts = attempts + 1, lease_token = NULL, updated_at = ?, last_error_code = ?, last_error_message = ? WHERE seq = ?")
            .run(now, diagnosticCodes.payloadMalformed, `The stored delivery could not be decoded: ${error instanceof Error ? error.message : String(error)}`, row.seq);
          return [];
        }
        const token = createId();
        database.query("UPDATE deliveries SET state = 'leased', attempts = attempts + 1, lease_token = ?, visible_at = ?, updated_at = ? WHERE seq = ?")
          .run(token, now + Math.max(1, request.leaseMs), now, row.seq);
        return [{ receipt: `${row.seq}:${token}`, id: row.delivery_id, attempt: row.attempts + 1, body }];
      });
    })();
    return leased;
  }

  /**
   * Applies a settlement statement to the delivery a receipt names.
   *
   * @param receipt - The receipt from `receive`.
   * @param statement - SQL that may use `$seq`, `$token`, `$now` and the names in `parameters`.
   * @param parameters - Further named parameters.
   * @returns Whether the lease was still held.
   */
  private settle(receipt: string, statement: string, parameters: Readonly<Record<string, string | number | null>>): boolean {
    const separator = receipt.indexOf(":");
    const seq = Number(receipt.slice(0, separator));
    if (separator < 1 || !Number.isSafeInteger(seq))
      return false;
    const candidates: Readonly<Record<string, string | number | null>> = { seq, token: receipt.slice(separator + 1), now: this.options.clock.now(), ...parameters };
    // Bind only the parameters the statement names; SQLite rejects unknown ones.
    const values = Object.fromEntries(Object.entries(candidates).filter(([name]) => statement.includes(`$${name}`)));
    return this.options.database.query(statement).run(values as never).changes > 0;
  }

  /**
   * Waits until the channel may have due deliveries: something was added in
   * this process, the earliest delay or lease ends, or the polling interval
   * passes (for deliveries added by another process).
   *
   * @param channel - The channel name, for example `queue:orders`.
   * @param signal - Ends the wait early.
   * @returns A promise that settles on the first of these.
   */
  private async wait(channel: string, signal: AbortSignal): Promise<void> {
    if (signal.aborted)
      return;
    const { clock, pollIntervalMs } = this.options;
    const next = this.nextDue(channel);
    const delay = Math.min(next === undefined ? pollIntervalMs : next - clock.now(), pollIntervalMs);
    if (delay <= 0)
      return;
    await new Promise<void>((resolve) => {
      const waiters = this.waiters.get(channel) ?? new Set<() => void>();
      this.waiters.set(channel, waiters);
      /** Cancels the wait's timer; replaced once the timer is set. */
      let cancel = (): void => {};
      /** Ends the wait and releases its timer and listeners. */
      const done = (): void => {
        cancel();
        waiters.delete(done);
        signal.removeEventListener("abort", done);
        resolve();
      };
      cancel = clock.setTimer(delay, done);
      waiters.add(done);
      signal.addEventListener("abort", done, { once: true });
    });
  }

  /**
   * Returns when the channel's next delivery becomes due.
   *
   * @param channel - The channel name, for example `queue:orders`.
   * @returns Epoch milliseconds, or `undefined` when nothing is pending.
   */
  private nextDue(channel: string): number | undefined {
    const row = this.options.database.query<{ next: number | null }, [string]>("SELECT MIN(visible_at) AS next FROM deliveries WHERE channel = ? AND state IN ('ready', 'leased')").get(channel);
    return row?.next ?? undefined;
  }
}

/**
 * Converts a failure into named statement parameters.
 *
 * @param failure - Why the delivery failed.
 * @returns `$code`, `$message` and `$invocation`.
 */
function failureFields(failure: DeliveryFailure): Readonly<Record<string, string | null>> {
  return { code: failure.code, message: failure.message, invocation: failure.invocationId ?? null };
}

/**
 * Converts a database row into its inspection form.
 *
 * @param row - A row read from the state database.
 * @returns The delivery as inspection reports it.
 */
function toStoredDelivery(row: DeliveryRow): StoredDelivery {
  return Object.freeze({
    seq: row.seq,
    id: row.delivery_id,
    body: row.body,
    state: row.state,
    attempts: row.attempts,
    visibleAt: row.visible_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...row.last_error_code === null
      ? {}
      : { lastError: Object.freeze({ code: row.last_error_code, message: row.last_error_message ?? "", ...row.last_invocation_id === null ? {} : { invocationId: row.last_invocation_id } }) }
  });
}