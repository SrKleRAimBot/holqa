import { defineBindings } from "@holqa/bindings";

import app from "@test/fixtures/apps/bound/infra";
import { brokerQueues } from "@test/fixtures/apps/bound/providers";

/** Both queues on one broker. */
export default defineBindings({ ...app, resources: { orders: { kind: "queue", id: "orders" }, audit: { kind: "queue", id: "audit" } } } as const, {
  name: "staging",
  kinds: { queue: brokerQueues("broker", "pull") }
});