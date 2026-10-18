import { scoped } from "@holqa/sdk";

/** A stored order. */
export interface Order {
  readonly orderId: string;
  readonly sku: string;
  readonly quantity: number;
  readonly placedBy: string;
  readonly status: "placed" | "cancelled";
}

/** An in-memory order store. Not durable: it lives as long as one runtime. */
export class OrderStore {
  /** Orders by identifier. */
  private readonly orders = new Map<string, Order>();
  /** The last number used in an order identifier. */
  private sequence = 0;

  /**
   * Stores a new order.
   *
   * @param order - The order without its identifier and status.
   * @returns The stored order.
   */
  place(order: Omit<Order, "orderId" | "status">): Order {
    this.sequence += 1;
    const placed: Order = { ...order, orderId: `ord_${this.sequence}`, status: "placed" };
    this.orders.set(placed.orderId, placed);
    return placed;
  }

  /**
   * Finds an order.
   *
   * @param orderId - The order's identifier.
   * @returns The order, or `undefined` when there is none.
   */
  find(orderId: string): Order | undefined {
    return this.orders.get(orderId);
  }

  /**
   * Marks an order as cancelled.
   *
   * @param orderId - The order's identifier.
   * @returns The cancelled order, or `undefined` when there is none.
   */
  cancel(orderId: string): Order | undefined {
    const order = this.orders.get(orderId);
    if (order === undefined)
      return undefined;
    const cancelled: Order = { ...order, status: "cancelled" };
    this.orders.set(orderId, cancelled);
    return cancelled;
  }

  /**
   * Lists orders.
   *
   * @param status - Only orders with this status, when given.
   * @returns The matching orders, oldest first.
   */
  list(status?: Order["status"]): Order[] {
    return [...this.orders.values()].filter(order => status === undefined || order.status === status);
  }
}

/** The order store, created once per runtime and shared by its invocations. */
export const orderStore = scoped({ name: "order-store", create: () => new OrderStore() });