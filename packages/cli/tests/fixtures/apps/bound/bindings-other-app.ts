import { defineBindings } from "@holqa/bindings";
import { brokerQueues } from "@test/fixtures/apps/bound/providers";

import {
  application,
  queue
} from "@test/support/descriptors";

const other = application("other", [queue("orders")]);

/** Binds a different application than the analyzed one. */
export default defineBindings({ ...other, resources: { orders: { kind: "queue", id: "orders" } } } as const, { kinds: { queue: brokerQueues("broker", "pull") } });