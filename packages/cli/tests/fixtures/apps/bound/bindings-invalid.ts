import { defineBindings } from "@holqa/bindings";

import app from "@test/fixtures/apps/bound/infra";
import { brokerQueues } from "@test/fixtures/apps/bound/providers";

/** The audit queue on a provider that delivers nothing, although it has a consumer. */
export default defineBindings({ ...app, resources: { orders: { kind: "queue", id: "orders" }, audit: { kind: "queue", id: "audit" } } } as const, {
  name: "broken",
  kinds: { queue: brokerQueues("broker", "pull") },
  resources: { audit: brokerQueues("send-only", "none") }
});