import type { QueueConsumerFor } from "@/index";

import { resources } from "@test/fixtures/shop/infra";

/**
 * A consumer function defined apart from its registration; its type comes from
 * the queue handle through a type-only import.
 *
 * @param context - The delivery context.
 * @param context.message - The decoded message: `placedAt` is a `Date` and `priority` is always present.
 */
export const processOrderFunction: QueueConsumerFor<typeof resources.orders> = async ({ message }) => {
  message.placedAt.getTime();
};

/** The queue's single consumer. */
export default resources.orders.consume({
  id: "orders.process",
  concurrency: 4,
  handler: processOrderFunction
});