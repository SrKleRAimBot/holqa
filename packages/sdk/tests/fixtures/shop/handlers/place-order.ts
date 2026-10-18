import type { QueueMessageInput } from "@/index";

import { resources } from "@test/fixtures/shop/infra";

/** The order a producer sends: the schema's input type, derived from the handle with no generated code. */
export type PlaceOrderInput = QueueMessageInput<typeof resources.orders>;

/**
 * Sends an order to the order queue. A producer in a different module from
 * both the declaration and the consumer.
 *
 * @param order - The order to send.
 * @returns Resolves when the runtime has accepted the message.
 */
export async function placeOrder(order: PlaceOrderInput): Promise<void> {
  await resources.orders.send(order);
}