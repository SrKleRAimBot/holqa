// Runs against a real RabbitMQ broker when HOLQA_RABBITMQ_URL is set, for
// example by CI's service container or:
//   docker run --rm -p 5672:5672 rabbitmq:4
//   HOLQA_RABBITMQ_URL=amqp://guest:guest@localhost:5672 pnpm --filter @holqa/rabbitmq test
// Without it, the tests are skipped; the in-memory broker tests cover the logic.
import type {
  AppDescriptor,
  ProviderContext,
  ResourceDescriptorOf
} from "@holqa/core";

import {
  queueConformance,
  registerConformance
} from "@holqa/conformance";
import {
  createBindingSlot,
  credentialRef,
  diagnosticsOf,
  parseResourceId
} from "@holqa/core";

import {
  describe,
  expect,
  it
} from "bun:test";

import { rabbitmq } from "@/provider";
import {
  queueTopology,
  topologyDeclarations
} from "@/topology";
import { rabbitMqTransport } from "@/transport";

const { HOLQA_RABBITMQ_URL: url } = process.env;
const enabled = url !== undefined && url !== "";

/**
 * Builds a queue resource with a unique identifier, so cases never share broker state.
 *
 * @returns The queue descriptor and its application.
 */
function uniqueQueue(): { readonly queue: ResourceDescriptorOf<"queue">; readonly app: AppDescriptor } {
  const id = (parseResourceId(`it-${crypto.randomUUID().slice(0, 8)}`) as { value: ResourceDescriptorOf<"queue">["id"] }).value;
  const queue: ResourceDescriptorOf<"queue"> = { protocol: 1, type: "resource", kind: "queue", id, config: { schemaVersion: 1 }, requirements: { delivery: "at-least-once", deadLetter: true }, schemas: { message: { "~standard": { version: 1, vendor: "test", validate: value => ({ value }) } } } };
  return { queue, app: { protocol: 1, type: "app", name: id, handlers: { include: [], exclude: [] }, resources: [queue], config: [], binding: createBindingSlot() } };
}

/**
 * Builds the context a provider is opened with.
 *
 * @param app - The application.
 * @param brokerUrl - The URL the credential resolves to.
 * @returns A context whose credentials resolve to the broker URL.
 */
function contextOf(app: AppDescriptor, brokerUrl: string): ProviderContext {
  return { app, environment: "integration", resources: app.resources, credential: () => brokerUrl, signal: new AbortController().signal, log: () => {} };
}

describe.skipIf(!enabled)("rabbitmq.queues against a real broker", () => {
  registerConformance(queueConformance, {
    time: { advance: ms => Bun.sleep(ms) },
    patienceMs: 15_000,
    leaseMs: 1_000,
    open: async () => {
      const { queue, app } = uniqueQueue();
      const admin = rabbitMqTransport(url!, { binding: "provisioning" });
      await admin.connect(10_000);
      const declarations = topologyDeclarations(queueTopology(queue.id, { deadLetter: true, delayQueues: true }), "quorum");
      for (const declaration of declarations)
        await admin.declare(declaration.queue, declaration.arguments);
      const provider = rabbitmq.queues({ url: credentialRef("QUEUE_URL"), delayedDelivery: "delay-queues", pollIntervalMs: 100 });
      const instance = await provider.open(contextOf(app, url!));
      return {
        driver: instance.drivers!.queue!(queue),
        source: instance.sources!.queue!(queue),
        capabilities: provider.resources.queue,
        close: async () => {
          await instance.stop!({ signal: AbortSignal.timeout(5_000) });
          for (const declaration of declarations)
            await admin.remove(declaration.queue);
          await admin.close();
        }
      };
    }
  }, { describe, it }, 60_000);

  it("classifies a rejected login as invalid credentials and a missing topology as failed", async () => {
    const { app } = uniqueQueue();
    const wrong = new URL(url!);
    wrong.password = "not-the-password";
    const provider = rabbitmq.queues({ url: credentialRef("QUEUE_URL"), connectTimeoutMs: 5_000 });
    let codes: string[] = [];
    try {
      await provider.open(contextOf(app, wrong.toString()));
    } catch (error) {
      codes = diagnosticsOf(error).map(diagnostic => diagnostic.code);
      expect(JSON.stringify(diagnosticsOf(error))).not.toContain("not-the-password");
    }
    expect(codes).toEqual(["HOLQA_BINDING_CREDENTIALS_INVALID"]);
    let missing: string[] = [];
    try {
      await provider.open(contextOf(app, url!));
    } catch (error) {
      missing = diagnosticsOf(error).map(diagnostic => diagnostic.code);
    }
    expect(missing).toEqual(["HOLQA_BINDING_FAILED"]);
  }, 30_000);
});