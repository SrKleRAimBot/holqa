import type {
  AppDescriptor,
  ResourceDescriptorOf
} from "@holqa/core";

import {
  defineProviderTests,
  providerTest,
  queueConformance
} from "@holqa/conformance";
import { getAppDescriptor } from "@holqa/core";
import {
  local,
  ManualClock
} from "@holqa/local";

import app from "@test/fixtures/apps/bound/infra";

const descriptor = getAppDescriptor(app) as AppDescriptor;
const queue = descriptor.resources.find(resource => resource.id === "orders") as ResourceDescriptorOf<"queue">;

/**
 * Creates the queue conformance harness of the in-memory local queue
 * provider, optionally with a driver that loses every message.
 *
 * @param lossy - Whether `send` drops messages instead of queueing them.
 * @returns The harness, with a fresh provider and clock per case.
 */
function harness(lossy: boolean) {
  let clock = new ManualClock();
  return () => ({
    time: { advance: async (ms: number) => {
      clock.advance(ms);
      await Bun.sleep(1);
    }, now: () => clock.now() },
    open: async () => {
      clock = new ManualClock();
      const provider = local.queues({ persistence: "memory", clock, env: {}, telemetry: false });
      const instance = await provider.open({ app: descriptor, environment: "test", resources: [queue], credential: () => "", signal: new AbortController().signal, log: () => {} });
      const driver = instance.drivers!.queue!(queue);
      return {
        driver: lossy ? { ...driver, send: async () => ({ messageId: "lost" }) } : driver,
        source: instance.sources!.queue!(queue),
        capabilities: provider.resources.queue,
        close: async () => instance.stop?.({ signal: new AbortController().signal })
      };
    }
  });
}

/** The local queue provider, and a broken copy that loses messages. */
export default defineProviderTests([
  providerTest("local queues", queueConformance, harness(false)),
  providerTest("lossy queues", queueConformance, harness(true))
]);