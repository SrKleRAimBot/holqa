/** The order states the example tracks. */
export type OrderStatus = "pending" | "paid" | "fulfilled" | "payment-failed";

/** A stored order. */
export interface OrderRecord {
  readonly orderId: string;
  readonly customerEmail: string;
  readonly status: OrderStatus;
  readonly total: number;
}

/**
 * The application's own persistence. Holqa does not provide a database; a real
 * application would use its own client here. This in-memory map stands in for
 * one so the example runs without infrastructure. It is module state, so it is
 * reset whenever the runtime loads a new generation, which is exactly why
 * production handlers must not rely on in-memory state.
 */
const orders = new Map<string, OrderRecord>();

/** Event identifiers already applied, used to make payment handling idempotent. */
const appliedEvents = new Set<string>();

/** Seed product catalog: SKU to price in minor units. */
export const catalog: ReadonlyMap<string, { readonly name: string; readonly price: number; readonly category: "kitchen" | "office" }> = new Map([
  ["MUG-001", { name: "Enamel mug", price: 1200, category: "kitchen" }],
  ["PEN-002", { name: "Fountain pen", price: 4500, category: "office" }],
  ["PAD-003", { name: "Dot-grid notebook", price: 900, category: "office" }]
]);

/**
 * Inserts an order unless one with the same identifier exists.
 *
 * @param record - The order to store.
 * @returns `true` when the order was inserted, `false` when it already existed.
 */
export function insertOrder(record: OrderRecord): boolean {
  if (orders.has(record.orderId))
    return false;
  orders.set(record.orderId, record);
  return true;
}

/**
 * Looks up an order.
 *
 * @param orderId - The order identifier.
 * @returns The stored order, or `undefined` when it does not exist.
 */
export function findOrder(orderId: string): OrderRecord | undefined {
  return orders.get(orderId);
}

/**
 * Moves an order to a new status.
 *
 * @param orderId - The order identifier.
 * @param status - The new status.
 * @returns `true` when the order exists and was updated.
 */
export function setOrderStatus(orderId: string, status: OrderStatus): boolean {
  const record = orders.get(orderId);
  if (record === undefined)
    return false;
  orders.set(orderId, { ...record, status });
  return true;
}

/**
 * Records that a payment event was applied.
 *
 * @param eventId - The provider's event identifier.
 * @returns `true` the first time an event is seen, `false` for duplicates.
 */
export function claimEvent(eventId: string): boolean {
  if (appliedEvents.has(eventId))
    return false;
  appliedEvents.add(eventId);
  return true;
}

/**
 * Lists orders in a given status.
 *
 * @param status - The status to filter by.
 * @returns Matching orders in insertion order.
 */
export function ordersWithStatus(status: OrderStatus): OrderRecord[] {
  return [...orders.values()].filter(record => record.status === status);
}