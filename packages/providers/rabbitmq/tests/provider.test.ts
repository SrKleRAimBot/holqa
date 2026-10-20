import type {
  AppDescriptor,
  LeasedDelivery,
  MessageEnvelope,
  ProviderContext,
  ProviderInstance,
  ResourceDescriptorOf
} from "@holqa/core";

import type { RabbitMqQueuesOptions } from "@/provider";

import {
  queueConformance,
  registerConformance
} from "@holqa/conformance";
import {
  createBindingSlot,
  credentialRef,
  diagnosticsOf,
  parseResourceId,
  validateProvider
} from "@holqa/core";
import {
  MemoryBroker,
  VirtualClock
} from "@test/support/memory-broker";

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

/** The queue every test uses. */
const jobs: ResourceDescriptorOf<"queue"> = { protocol: 1, type: "resource", kind: "queue", id: (parseResourceId("jobs") as { value: ResourceDescriptorOf<"queue">["id"] }).value, config: { schemaVersion: 1 }, requirements: { delivery: "at-least-once", deadLetter: true }, schemas: { message: { "~standard": { version: 1, vendor: "test", validate: value => ({ value }) } } } };

/** The application every test uses. */
const app: AppDescriptor = { protocol: 1, type: "app", name: jobs.id, handlers: { include: [], exclude: [] }, resources: [jobs], config: [], binding: createBindingSlot() };

/**
 * Builds the context a provider is opened with.
 *
 * @param url - The value of the `QUEUE_URL` credential.
 * @returns A context whose credentials resolve to `url`.
 */
function contextOf(url = "amqp://guest:guest@broker"): ProviderContext {
  return { app, environment: "test", resources: [jobs], credential: () => url, signal: new AbortController().signal, log: () => {} };
}

/**
 * Opens the provider on an in-memory broker with the queue's topology declared.
 *
 * @param options - Provider settings to override.
 * @param declare - Whether to declare the topology first.
 * @returns The broker, the opened instance and the queue's driver and source.
 */
async function openOn(options: Partial<RabbitMqQueuesOptions> = {}, declare = true) {
  const broker = new MemoryBroker(new VirtualClock());
  const settings = { deadLetter: true, delayQueues: (options.delayedDelivery ?? "delay-queues") === "delay-queues" };
  if (declare) {
    for (const declaration of topologyDeclarations(queueTopology("jobs", settings), "quorum"))
      broker.declare(declaration.queue, declaration.arguments);
  }
  const provider = rabbitmq.queues({ url: credentialRef("QUEUE_URL"), delayedDelivery: "delay-queues", transport: (_url, transportOptions) => broker.transport(transportOptions.binding), clock: broker.clock, ...options });
  const instance: ProviderInstance = await provider.open(contextOf());
  return { broker, provider, instance, driver: instance.drivers!.queue!(jobs), source: instance.sources!.queue!(jobs) };
}

/**
 * Builds an envelope.
 *
 * @param payload - The wire payload to wrap.
 * @returns A version 1 envelope.
 */
function envelope(payload: MessageEnvelope["payload"]): MessageEnvelope {
  return { format: "holqa.message/1", schemaVersion: 1, payload };
}

/**
 * Receives one delivery, letting virtual time pass until it arrives.
 *
 * @param opened - The opened provider.
 * @param leaseMs - The lease to request.
 * @returns The delivery.
 */
async function receive(opened: Awaited<ReturnType<typeof openOn>>, leaseMs = 30_000): Promise<LeasedDelivery<MessageEnvelope>> {
  for (let step = 0; step < 2_000; step++) {
    const [delivery] = await opened.source.receive({ max: 1, leaseMs });
    if (delivery !== undefined)
      return delivery;
    await opened.broker.clock.advance(100);
  }
  throw new Error("No delivery arrived.");
}

/**
 * Collects the codes a promise rejects with.
 *
 * @param promise - A promise expected to reject with a Holqa error.
 * @returns The diagnostic codes.
 */
async function rejection(promise: Promise<unknown>): Promise<string[]> {
  try {
    await promise;
  } catch (error) {
    return diagnosticsOf(error).map(diagnostic => diagnostic.code);
  }
  return [];
}

describe("rabbitmq.queues on an in-memory broker", () => {
  let clock = new VirtualClock();
  registerConformance(queueConformance, {
    time: { advance: ms => clock.advance(ms), now: () => clock.now() },
    open: async () => {
      const opened = await openOn();
      clock = opened.broker.clock;
      return { driver: opened.driver, source: opened.source, capabilities: opened.provider.resources.queue, close: () => opened.instance.stop!({ signal: new AbortController().signal }) };
    }
  }, { describe, it });
});

describe("rabbitmq.queues", () => {
  it("declares honest capabilities: delays only through the explicitly enabled emulation", () => {
    const plain = rabbitmq.queues({ url: credentialRef("QUEUE_URL") });
    expect(validateProvider(plain)).toEqual([]);
    expect(plain.resources.queue).toEqual({ delivery: ["at-least-once"], maxAttempts: 25, deadLetter: true, maxMessageBytes: 16_777_216 });
    expect(plain.emulations).toEqual([]);
    expect(plain.credentials).toEqual([{ type: "credential", name: "QUEUE_URL" }]);
    const delayed = rabbitmq.queues({ url: credentialRef("QUEUE_URL"), delayedDelivery: "delay-queues" });
    expect(delayed.resources.queue).toMatchObject({ backoff: ["fixed", "exponential"], maxDelaySeconds: 900 });
    expect(delayed.emulations?.map(emulation => emulation.capability)).toEqual(["queue.delay", "queue.backoff.fixed", "queue.backoff.exponential"]);
    expect(JSON.stringify(delayed)).not.toContain("amqp://");
  });

  it("rejects malformed settings, including a URL that is not a credential reference", () => {
    let codes: string[] = [];
    try {
      rabbitmq.queues({ url: "amqp://guest:guest@broker" as never, delayedDelivery: "plugin" as never, prefetch: 0, queues: { jobs: "amq.reserved" } });
    } catch (error) {
      codes = diagnosticsOf(error).map(diagnostic => diagnostic.code);
    }
    expect(codes).toEqual(["HOLQA_BINDING_CONFIG_INVALID", "HOLQA_BINDING_CONFIG_INVALID", "HOLQA_BINDING_CONFIG_INVALID", "HOLQA_BINDING_CONFIG_INVALID"]);
  });

  it("refuses to start when the topology is missing, without creating it", async () => {
    let failure: unknown;
    try {
      await openOn({}, false);
    } catch (error) {
      failure = error;
    }
    expect(diagnosticsOf(failure).map(diagnostic => [diagnostic.code, (diagnostic.details as { readonly failure?: unknown } | undefined)?.failure])).toEqual([["HOLQA_BINDING_FAILED", "failed"]]);
  });

  it("classifies a rejected login and an unreachable broker", async () => {
    for (const kind of ["credentials-invalid", "unavailable"] as const) {
      const broker = new MemoryBroker();
      broker.connectFailure = kind;
      const provider = rabbitmq.queues({ url: credentialRef("QUEUE_URL"), transport: (_url, transportOptions) => broker.transport(transportOptions.binding) });
      expect(await rejection(provider.open(contextOf()))).toEqual([kind === "unavailable" ? "HOLQA_BINDING_UNAVAILABLE" : "HOLQA_BINDING_CREDENTIALS_INVALID"]);
    }
  });

  it("rounds delays up to the next delay step, never earlier", async () => {
    const opened = await openOn();
    await opened.driver.send(envelope("later"), { delaySeconds: 3 });
    expect(opened.broker.messages("jobs.delay.5")).toHaveLength(1);
    await opened.broker.clock.advance(4_999);
    expect(await opened.source.receive({ max: 1, leaseMs: 1_000 })).toEqual([]);
    await opened.broker.clock.advance(1);
    expect((await receive(opened)).body.payload).toBe("later");
  });

  it("counts attempts across retries and lost connections and keeps the message identifier", async () => {
    const opened = await openOn();
    const { messageId } = await opened.driver.send(envelope("x"), {});
    const first = await receive(opened);
    expect(first.attempt).toBe(1);
    await opened.source.retry(first.receipt, 1_000, { code: "HOLQA_HANDLER_FAILED", message: "boom", attempt: 1 });
    const second = await receive(opened);
    expect([second.id, second.attempt]).toEqual([messageId, 2]);
    opened.broker.dropConnection();
    expect(await opened.source.acknowledge(second.receipt)).toBe(false);
    const third = await receive(opened);
    expect([third.id, third.attempt]).toEqual([messageId, 3]);
    expect(await opened.source.acknowledge(third.receipt)).toBe(true);
  });

  it("dead-letters with the failure recorded and quarantines messages that are not envelopes", async () => {
    const opened = await openOn();
    await opened.driver.send(envelope("dead"), {});
    const delivery = await receive(opened);
    await opened.source.deadLetter(delivery.receipt, { code: "HOLQA_INPUT_INVALID", message: "bad", attempt: 1, invocationId: "inv-1" });
    expect(opened.broker.messages("jobs.dead-letter").map(message => message.headers)).toEqual([expect.objectContaining({ "x-holqa-failure-code": "HOLQA_INPUT_INVALID", "x-holqa-failure-invocation": "inv-1", "x-holqa-attempts": 1 })]);
    await opened.broker.transport("test").publish("jobs", new TextEncoder().encode("not json"), { messageId: "foreign", headers: {} });
    await opened.source.receive({ max: 1, leaseMs: 1_000 });
    await opened.broker.clock.advance(10);
    expect(opened.broker.messages("jobs.dead-letter").map(message => [message.messageId, message.headers["x-holqa-failure-code"]])).toContainEqual(["foreign", "HOLQA_PAYLOAD_MALFORMED"]);
  });

  it("requeues the original when publishing the retry copy fails, so nothing is lost", async () => {
    const opened = await openOn();
    const { messageId } = await opened.driver.send(envelope("kept"), {});
    const delivery = await receive(opened);
    opened.broker.failPublishes = 1;
    expect(await opened.source.retry(delivery.receipt, 1_000, { code: "HOLQA_HANDLER_FAILED", message: "boom", attempt: 1 })).toBe(false);
    const again = await receive(opened);
    expect(again.id).toBe(messageId);
  });

  it("reports send failures as unavailable and health as degraded while offline", async () => {
    const opened = await openOn();
    opened.broker.goOffline();
    expect(await rejection(opened.driver.send(envelope("x"), {}))).toEqual(["HOLQA_BINDING_UNAVAILABLE"]);
    expect((await opened.instance.health!()).status).toBe("degraded");
    opened.broker.restore();
    expect((await opened.instance.health!()).status).toBe("healthy");
    await opened.driver.send(envelope("back"), {});
  });

  it("returns unsettled deliveries to the queue when stopped", async () => {
    const opened = await openOn();
    await opened.driver.send(envelope("in flight"), {});
    await receive(opened);
    await opened.instance.stop!({ signal: new AbortController().signal });
    expect(opened.broker.messages("jobs")).toHaveLength(1);
  });

  it("maps resources to broker queues by name or prefix", async () => {
    const broker = new MemoryBroker();
    for (const declaration of topologyDeclarations(queueTopology("shop.jobs", { deadLetter: true, delayQueues: false }), "classic"))
      broker.declare(declaration.queue, declaration.arguments);
    const provider = rabbitmq.queues({ url: credentialRef("QUEUE_URL"), prefix: "shop.", transport: (_url, transportOptions) => broker.transport(transportOptions.binding), clock: broker.clock });
    const instance = await provider.open(contextOf());
    await instance.drivers!.queue!(jobs).send(envelope("prefixed"), {});
    expect(broker.messages("shop.jobs")).toHaveLength(1);
    expect(await rejection(instance.drivers!.queue!(jobs).send(envelope("x"), { delaySeconds: 5 }))).toEqual(["HOLQA_BINDING_CAPABILITY_UNSUPPORTED"]);
  });
});