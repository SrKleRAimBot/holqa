import type { BindingProvider } from "@holqa/core";

import { credentialRef } from "@holqa/core";

/**
 * A queue provider described as data, for binding inspection. It is never opened.
 *
 * @param name - The provider's name.
 * @param delivery - How it delivers messages.
 * @returns The provider.
 */
export function brokerQueues(name: string, delivery: "pull" | "none"): BindingProvider<"queue"> {
  return {
    bindingProtocol: 1,
    provider: "example.broker",
    name,
    role: "resource",
    contracts: { queue: 1 },
    resources: { queue: { delivery: ["at-least-once"], maxAttempts: 10, deadLetter: true, backoff: ["fixed", "exponential"], maxDelaySeconds: 900 } },
    services: {},
    emulations: [{ kind: "queue", capability: "queue.backoff.exponential", mechanism: "delay queues with message expiry", requires: ["one delay queue per delay step"] }],
    topology: { delivery, state: "shared", connectors: delivery === "pull" ? ["a long-running consumer process"] : [] },
    settings: { exchange: "orders" },
    credentials: [credentialRef("QUEUE_URL")],
    open: async () => {
      throw new Error("Binding inspection must never open a provider.");
    }
  };
}