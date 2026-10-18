import type { QueueConsumerFor } from "@/index";

import { resources } from "@test/fixtures/shop/infra";

/**
 * A consumer function written apart from its registration, typed through the handle.
 *
 * @param context - The delivery context.
 * @param context.message - The validated reindex request.
 */
export const reindexProduct: QueueConsumerFor<typeof resources.reindex> = ({ message }) => {
  void message.productId;
};

/** Registers the reindex consumer. */
export default resources.reindex.consume({ id: "catalog.reindex", handler: reindexProduct });