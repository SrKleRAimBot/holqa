import type {
  HandlerDescriptor,
  InvocationContext,
  MessageEnvelope,
  ObjectEvent,
  QueueRequirements,
  ResourceDescriptor,
  RuntimeBinding
} from "@holqa/core";

import type { RuntimeOptions } from "@/runtime/create-runtime";
import {
  createDiagnostic,
  HolqaError
} from "@holqa/core";
import {
  application,
  described,
  id,
  latch,
  nonEmptyString,
  scheduleHandler,
  sequentialIds
} from "@test/support/descriptors";
import {
  ManualSchedule,
  MemorySource
} from "@test/support/memory-sources";

import {
  describe,
  expect,
  it
} from "bun:test";

import { silentSink } from "@/logging/log";
import { createRuntime } from "@/runtime/create-runtime";

/**
 * Builds a queue whose messages are non-empty strings.
 *
 * @param requirements - Overrides of the delivery requirements.
 * @param schemaVersion - The contract version.
 * @returns The resource descriptor.
 */
function queue(requirements: Partial<QueueRequirements> = {}, schemaVersion = 1): ResourceDescriptor {
  return { protocol: 1, type: "resource", kind: "queue", id: id("jobs"), config: { schemaVersion }, requirements: { delivery: "at-least-once", deadLetter: true, maxAttempts: 3, ...requirements }, schemas: { message: nonEmptyString } };
}

/** What a fixture consumer receives. */
type QueueContext = InvocationContext<{ readonly attempt: number; readonly messageId: string; readonly schemaVersion?: number }>;

/**
 * Builds a consumer of the `jobs` queue.
 *
 * @param handle - Runs for every message.
 * @param concurrency - How many messages may run at once; absent means the runtime default.
 * @returns A value carrying the handler descriptor.
 */
function consumer(handle: (message: unknown, context: QueueContext) => unknown, concurrency?: number): ReturnType<typeof described<HandlerDescriptor>> {
  return described({
    protocol: 1,
    type: "handler",
    definition: { id: id("jobs.run"), trigger: { kind: "queue.message", resource: { kind: "queue", id: id("jobs") }, options: concurrency === undefined ? {} : { concurrency } } },
    schemas: { message: nonEmptyString },
    invoke: async (input: unknown, context: QueueContext) => handle(input, context)
  } as HandlerDescriptor);
}

/**
 * Builds an envelope for the `jobs` queue.
 *
 * @param payload - The message.
 * @param schemaVersion - The producer's version.
 * @returns A `holqa.message/1` envelope.
 */
function envelope(payload: string | number, schemaVersion = 1): MessageEnvelope {
  return { format: "holqa.message/1", schemaVersion, payload };
}

/**
 * Builds a binding that delivers from in-memory sources.
 *
 * @param sources - The sources to expose.
 * @param sources.queue - Deliveries of the `jobs` queue.
 * @param sources.events - Object events of the `files` bucket, for every subscription.
 * @param sources.schedule - Ticks of the `nightly` schedule.
 * @returns A binding with full capabilities whose sources are the given fakes.
 */
function memoryBinding(sources: { readonly queue?: MemorySource<MessageEnvelope>; readonly events?: MemorySource<ObjectEvent>; readonly schedule?: ManualSchedule }): RuntimeBinding & { readonly subscriptions: unknown[] } {
  const subscriptions: unknown[] = [];
  return {
    name: "memory",
    subscriptions,
    capabilities: {
      queue: { delivery: ["at-least-once"], maxAttempts: 10, deadLetter: true, backoff: ["fixed", "exponential"], maxDelaySeconds: 900 },
      bucket: { access: ["private"], events: ["object.created", "object.deleted"] },
      schedule: { overlap: ["skip", "allow"] }
    },
    drivers: {
      queue: () => ({ send: async () => ({ messageId: "m" }) }),
      bucket: () => {
        throw new Error("not used");
      }
    },
    sources: {
      ...sources.queue === undefined ? {} : { queue: () => sources.queue! },
      ...sources.events === undefined
        ? {}
        : { bucket: () => ({ subscribe: async (subscription) => {
          subscriptions.push(subscription);
          return sources.events!;
        } }) },
      ...sources.schedule === undefined ? {} : { schedule: () => sources.schedule! }
    },
    config: () => undefined
  };
}

/**
 * Waits until a condition holds, polling every millisecond for at most two seconds.
 *
 * @param condition - The condition to wait for.
 * @returns A promise that settles once the condition holds.
 * @throws {Error} When the condition does not hold in time.
 */
async function until(condition: () => boolean): Promise<void> {
  for (let round = 0; round < 2_000; round += 1) {
    if (condition())
      return;
    await Bun.sleep(1);
  }
  throw new Error("The condition did not hold in time.");
}

/**
 * Creates a runtime with silent logs and sequential identifiers.
 *
 * @param options - The application, handlers and binding.
 * @returns A runtime in the idle state.
 */
function runtimeOf(options: Partial<RuntimeOptions> & Pick<RuntimeOptions, "app" | "handlers" | "binding">): ReturnType<typeof createRuntime> {
  return createRuntime({ log: silentSink, createId: sequentialIds(), ...options });
}

describe("queue delivery", () => {
  it("delivers validated messages with their identity, attempt and schema version, and acknowledges them", async () => {
    const source = new MemorySource<MessageEnvelope>();
    const seen: unknown[] = [];
    const runtime = runtimeOf({ app: application([queue()]), handlers: [consumer((message, context) => seen.push({ message, ...context.metadata }))], binding: memoryBinding({ queue: source }) });
    await runtime.start();
    source.add("m-1", envelope("hello"));
    await source.drained();
    expect(seen).toEqual([{ message: "hello", attempt: 1, messageId: "m-1", schemaVersion: 1 }]);
    expect(source.settlements).toEqual([{ kind: "acknowledge", id: "m-1", attempt: 1 }]);
    expect(runtime.stats().delivery.queues).toMatchObject({ received: 1, acknowledged: 1 });
    await runtime.stop();
  });

  it("retries failures after the declared backoff and dead-letters after the last attempt", async () => {
    const source = new MemorySource<MessageEnvelope>();
    let calls = 0;
    const runtime = runtimeOf({
      app: application([queue({ maxAttempts: 3, backoff: { strategy: "exponential", initialDelaySeconds: 2, maxDelaySeconds: 60 } })]),
      handlers: [consumer(() => {
        calls += 1;
        throw new Error("boom");
      })],
      binding: memoryBinding({ queue: source })
    });
    await runtime.start();
    source.add("m-1", envelope("work"));
    await source.drained();
    source.advance(2_000);
    await source.drained();
    source.advance(4_000);
    await source.drained();
    expect(calls).toBe(3);
    expect(source.settlements.map(({ kind, attempt, delayMs, failure }) => ({ kind, attempt, delayMs, code: failure?.code }))).toEqual([
      { kind: "retry", attempt: 1, delayMs: 2_000, code: "HOLQA_HANDLER_FAILED" },
      { kind: "retry", attempt: 2, delayMs: 4_000, code: "HOLQA_HANDLER_FAILED" },
      { kind: "deadLetter", attempt: 3, delayMs: undefined, code: "HOLQA_HANDLER_FAILED" }
    ]);
    await runtime.stop();
  });

  it("discards exhausted messages when the queue requires no dead-letter destination", async () => {
    const source = new MemorySource<MessageEnvelope>();
    const runtime = runtimeOf({ app: application([queue({ maxAttempts: 1, deadLetter: false })]), handlers: [consumer(() => {
      throw new Error("boom");
    })], binding: memoryBinding({ queue: source }) });
    await runtime.start();
    source.add("m-1", envelope("work"));
    await source.drained();
    expect(source.settlements.map(settlement => settlement.kind)).toEqual(["discard"]);
    await runtime.stop();
  });

  it("dead-letters messages that cannot succeed without invoking the consumer or retrying", async () => {
    const source = new MemorySource<MessageEnvelope>();
    let calls = 0;
    const runtime = runtimeOf({ app: application([queue({}, 2)]), handlers: [consumer(() => calls += 1)], binding: memoryBinding({ queue: source }) });
    await runtime.start();
    source.add("old-version", envelope("x", 1));
    source.add("invalid", envelope("", 2));
    source.add("not-an-envelope", { payload: "x" } as unknown as MessageEnvelope);
    source.add("too-many-attempts", envelope("x", 2), 3);
    await source.drained();
    expect(calls).toBe(0);
    expect(Object.fromEntries(source.settlements.map(settlement => [settlement.id, `${settlement.kind}:${settlement.failure?.code}`]))).toEqual({
      "old-version": "deadLetter:HOLQA_PAYLOAD_VERSION_UNSUPPORTED",
      "invalid": "deadLetter:HOLQA_INPUT_INVALID",
      "not-an-envelope": "deadLetter:HOLQA_PAYLOAD_MALFORMED",
      "too-many-attempts": "deadLetter:HOLQA_DELIVERY_ATTEMPTS_EXHAUSTED"
    });
    await runtime.stop();
  });

  it("never leases more messages than the consumer can run at once", async () => {
    const source = new MemorySource<MessageEnvelope>();
    const gate = latch();
    let active = 0;
    let peak = 0;
    const runtime = runtimeOf({ app: application([queue()]), handlers: [consumer(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await gate.promise;
      active -= 1;
    }, 2)], binding: memoryBinding({ queue: source }) });
    await runtime.start();
    for (const index of [1, 2, 3, 4, 5])
      source.add(`m-${index}`, envelope(`job ${index}`));
    await until(() => active === 2);
    // Further work stays queued while both slots are busy.
    await Bun.sleep(5);
    expect(active).toBe(2);
    gate.release();
    await source.drained();
    expect(peak).toBe(2);
    expect(source.requests.every(request => request.max <= 2)).toBe(true);
    expect(source.settlements.filter(settlement => settlement.kind === "acknowledge")).toHaveLength(5);
    await runtime.stop();
  });

  it("finishes in-flight messages on graceful shutdown and releases those that outlive the grace period", async () => {
    const source = new MemorySource<MessageEnvelope>();
    const quick = latch();
    let started = 0;
    const runtime = runtimeOf({ app: application([queue()]), handlers: [consumer(async (message, context) => {
      started += 1;
      if (message === "quick")
        return quick.promise;
      await new Promise(resolve => context.signal.addEventListener("abort", resolve));
      return undefined;
    }, 2)], binding: memoryBinding({ queue: source }) });
    await runtime.start();
    source.add("quick", envelope("quick"));
    source.add("stuck", envelope("stuck"));
    await until(() => started === 2);
    const stopping = runtime.stop({ graceMs: 200, forceMs: 50 });
    quick.release();
    await stopping;
    expect(Object.fromEntries(source.settlements.map(settlement => [settlement.id, settlement.kind]))).toEqual({ quick: "acknowledge", stuck: "retry" });
    expect(source.settlements.find(settlement => settlement.id === "stuck")?.delayMs).toBe(0);
    expect(runtime.stats().delivery.queues).toMatchObject({ acknowledged: 1, released: 1 });
    // Nothing is received after the runtime stopped.
    const requests = source.requests.length;
    source.add("late", envelope("late"));
    await Bun.sleep(5);
    expect(source.requests).toHaveLength(requests);
  });

  it("retries messages with a newer schema version, as during a rolling deploy, and dead-letters older ones", async () => {
    const source = new MemorySource<MessageEnvelope>();
    let calls = 0;
    const runtime = runtimeOf({ app: application([queue({ maxAttempts: 2, backoff: { strategy: "fixed", delaySeconds: 1 } }, 2)]), handlers: [consumer(() => calls += 1)], binding: memoryBinding({ queue: source }) });
    await runtime.start();
    source.add("newer", envelope("x", 3));
    source.add("older", envelope("x", 1));
    await source.drained();
    source.advance(1_000);
    await source.drained();
    expect(calls).toBe(0);
    expect(source.settlements.map(({ id, kind, failure }) => `${id}:${kind}:${failure?.code}`).sort()).toEqual([
      "newer:deadLetter:HOLQA_PAYLOAD_VERSION_UNSUPPORTED",
      "newer:retry:HOLQA_PAYLOAD_VERSION_UNSUPPORTED",
      "older:deadLetter:HOLQA_PAYLOAD_VERSION_UNSUPPORTED"
    ]);
    await runtime.stop();
  });

  it("renews the lease of a long-running message when the source can extend leases", async () => {
    const source = new MemorySource<MessageEnvelope>();
    const extensions: number[] = [];
    const extendable = Object.assign(source, { extend: async (_receipt: string, leaseMs: number) => {
      extensions.push(leaseMs);
      return true;
    } });
    const gate = latch();
    const runtime = runtimeOf({ app: application([queue()]), handlers: [consumer(async () => gate.promise)], binding: memoryBinding({ queue: extendable }), delivery: { leaseMs: 10 } });
    await runtime.start();
    source.add("m-1", envelope("long"));
    await until(() => extensions.length >= 2);
    gate.release();
    await source.drained();
    expect(extensions.every(leaseMs => leaseMs === 10)).toBe(true);
    await runtime.stop();
  });

  it("refuses to start when the binding cannot delay redeliveries as long as the default backoff needs", async () => {
    const binding = memoryBinding({ queue: new MemorySource<MessageEnvelope>() });
    const limited = { ...binding, capabilities: { ...binding.capabilities, queue: { delivery: ["at-least-once" as const], maxAttempts: 10, deadLetter: true, maxDelaySeconds: 60 } } };
    const runtime = runtimeOf({ app: application([queue({ backoff: undefined } as never)]), handlers: [consumer(() => undefined)], binding: limited });
    const codes = await runtime.start().then(() => [], (error: { readonly diagnostics: ReadonlyArray<{ readonly code: string }> }) => error.diagnostics.map(diagnostic => diagnostic.code));
    expect(codes).toEqual(["HOLQA_RUNTIME_START_FAILED", "HOLQA_BINDING_CAPABILITY_UNSUPPORTED"]);
  });

  it("rejects a second consumer for the same queue", () => {
    const second = consumer(() => undefined);
    const other = described({ ...second["~holqa"], definition: { ...second["~holqa"].definition, id: id("jobs.other") }, invoke: async () => undefined } as HandlerDescriptor);
    expect(() => runtimeOf({ app: application([queue()]), handlers: [consumer(() => undefined), other], binding: memoryBinding({}) })).toThrow("HOLQA_QUEUE_CONSUMER_DUPLICATE");
  });
});

describe("object event delivery", () => {
  /** A bucket. */
  const files: ResourceDescriptor = { protocol: 1, type: "resource", kind: "bucket", id: id("files"), config: {}, requirements: { access: "private" }, schemas: {} };

  /**
   * Builds an object event handler.
   *
   * @param kind - The trigger kind.
   * @param handle - Runs for every event.
   * @param prefix - The key prefix filter.
   * @returns A value carrying the handler descriptor.
   */
  function objectHandler(kind: "bucket.object-created" | "bucket.object-deleted", handle: (input: unknown, metadata: unknown) => unknown, prefix?: string): ReturnType<typeof described<HandlerDescriptor>> {
    return described({
      protocol: 1,
      type: "handler",
      definition: { id: id(kind === "bucket.object-created" ? "files.created" : "files.deleted"), trigger: { kind, resource: { kind: "bucket", id: id("files") }, options: prefix === undefined ? {} : { prefix } } },
      schemas: { object: nonEmptyString },
      invoke: async (input: unknown, context: InvocationContext<unknown>) => handle(input, context.metadata)
    } as HandlerDescriptor);
  }

  /**
   * Builds an object event.
   *
   * @param eventId - The event identity.
   * @param type - Whether the object was created or deleted.
   * @param key - The object key.
   * @returns A `holqa.object-event/1` envelope.
   */
  function event(eventId: string, type: ObjectEvent["type"], key: string): ObjectEvent {
    return { format: "holqa.object-event/1", id: eventId, type, bucket: "files", time: "2026-10-18T09:00:00.000Z", object: type === "object.created" ? { key, size: 3, contentType: "text/plain", etag: "e" } : { key } };
  }

  it("subscribes each handler with its filter and delivers the portable object description", async () => {
    const source = new MemorySource<ObjectEvent>();
    const seen: unknown[] = [];
    const binding = memoryBinding({ events: source });
    const runtime = runtimeOf({ app: application([files]), handlers: [objectHandler("bucket.object-created", (input, metadata) => seen.push({ input, metadata }), "raw/")], binding });
    await runtime.start();
    expect(binding.subscriptions).toEqual([{ id: "files.created", types: ["object.created"], prefix: "raw/" }]);
    source.add("e-1", event("e-1", "object.created", "raw/a.txt"));
    source.add("e-2", event("e-2", "object.created", "other/b.txt"));
    source.add("e-3", event("e-3", "object.deleted", "raw/a.txt"));
    await source.drained();
    expect(seen).toEqual([{ input: { key: "raw/a.txt", size: 3, contentType: "text/plain" }, metadata: { eventId: "e-1", eventTime: "2026-10-18T09:00:00.000Z", attempt: 1 } }]);
    expect(source.settlements.map(settlement => `${settlement.id}:${settlement.kind}`).sort()).toEqual(["e-1:acknowledge", "e-2:acknowledge", "e-3:acknowledge"]);
    await runtime.stop();
  });

  it("retries failed events with the runtime's object event policy and dead-letters them", async () => {
    const source = new MemorySource<ObjectEvent>();
    const attempts: unknown[] = [];
    const runtime = runtimeOf({
      app: application([files]),
      handlers: [objectHandler("bucket.object-deleted", (_input, metadata) => {
        attempts.push(metadata);
        throw new Error("boom");
      })],
      binding: memoryBinding({ events: source }),
      delivery: { objectEvents: { maxAttempts: 2, backoff: { strategy: "fixed", delaySeconds: 1 } } }
    });
    await runtime.start();
    source.add("e-1", event("e-1", "object.deleted", "a.txt"));
    await source.drained();
    source.advance(1_000);
    await source.drained();
    expect(attempts).toEqual([{ eventId: "e-1", eventTime: "2026-10-18T09:00:00.000Z", attempt: 1 }, { eventId: "e-1", eventTime: "2026-10-18T09:00:00.000Z", attempt: 2 }]);
    expect(source.settlements.map(settlement => settlement.kind)).toEqual(["retry", "deadLetter"]);
    await runtime.stop();
  });

  it("refuses to start when the binding does not deliver the handler's event type", async () => {
    const binding = memoryBinding({ events: new MemorySource<ObjectEvent>() });
    const runtime = runtimeOf({ app: application([files]), handlers: [objectHandler("bucket.object-deleted", () => undefined)], binding: { ...binding, capabilities: { ...binding.capabilities, bucket: { access: ["private"], events: ["object.created"] } } } });
    expect(await runtime.start().then(() => "started", (error: { readonly diagnostics: ReadonlyArray<{ readonly code: string }> }) => error.diagnostics.map(diagnostic => diagnostic.code))).toEqual(["HOLQA_RUNTIME_START_FAILED", "HOLQA_BINDING_CAPABILITY_UNSUPPORTED"]);
  });
});

describe("scheduled runs", () => {
  /**
   * Builds the `nightly` schedule with an overlap policy.
   *
   * @param overlap - The policy.
   * @returns The resource descriptor.
   */
  function nightly(overlap: "skip" | "allow"): ResourceDescriptor {
    return { protocol: 1, type: "resource", kind: "schedule", id: id("nightly"), config: { cron: "0 3 * * *", timezone: "UTC" }, requirements: { overlap }, schemas: {} };
  }

  it("runs ticks through the dispatcher and reports their results", async () => {
    const schedule = new ManualSchedule();
    const seen: unknown[] = [];
    let fail = false;
    const runtime = runtimeOf({ app: application([nightly("skip")]), handlers: [scheduleHandler("nightly.run", "nightly", (context) => {
      seen.push(context.metadata);
      if (fail)
        throw new Error("boom");
    })], binding: memoryBinding({ schedule }) });
    await runtime.start();
    expect(await schedule.fire("run-1", "manual")).toEqual({ status: "succeeded", invocationId: "inv-1" });
    fail = true;
    expect(await schedule.fire("run-2")).toMatchObject({ status: "failed", code: "HOLQA_HANDLER_FAILED" });
    expect(seen).toEqual([
      { scheduledTime: "2026-10-18T03:00:00.000Z", runId: "run-1", trigger: "manual" },
      { scheduledTime: "2026-10-18T03:00:00.000Z", runId: "run-2", trigger: "cron" }
    ]);
    await runtime.stop();
  });

  it.each([
    ["skip", ["succeeded", "skipped"]],
    ["allow", ["succeeded", "succeeded"]]
  ] as const)("applies the %p overlap policy to a run due while another is in progress", async (overlap, statuses) => {
    const schedule = new ManualSchedule();
    const gate = latch();
    const runtime = runtimeOf({ app: application([nightly(overlap)]), handlers: [scheduleHandler("nightly.run", "nightly", async () => gate.promise)], binding: memoryBinding({ schedule }) });
    await runtime.start();
    const first = schedule.fire("run-1");
    await Bun.sleep(1);
    const second = schedule.fire("run-2");
    await Bun.sleep(1);
    gate.release();
    expect((await Promise.all([first, second])).map(result => result.status)).toEqual([...statuses]);
    if (overlap === "skip")
      expect(await second).toMatchObject({ code: "HOLQA_SCHEDULE_RUN_SKIPPED" });
    await runtime.stop();
  });

  it("stops listening to the scheduler when the runtime stops", async () => {
    const schedule = new ManualSchedule();
    const runtime = runtimeOf({ app: application([nightly("skip")]), handlers: [scheduleHandler("nightly.run", "nightly", () => undefined)], binding: memoryBinding({ schedule }) });
    await runtime.start();
    await runtime.stop();
    await expect(schedule.fire("late")).rejects.toThrow("No runtime is subscribed.");
  });

  it("rolls back a start whose source fails, releasing the binding", async () => {
    const binding = memoryBinding({ schedule: new ManualSchedule() });
    const failing = { ...binding, sources: { schedule: () => ({ start: async () => {
      throw new HolqaError(createDiagnostic({ code: "HOLQA_SCHEDULE_INVALID", severity: "error", message: "never fires" }));
    } }) } };
    const app = application([nightly("skip")]);
    const runtime = runtimeOf({ app, handlers: [scheduleHandler("nightly.run", "nightly", () => undefined)], binding: failing });
    const codes = await runtime.start().then(() => [], (error: { readonly diagnostics: ReadonlyArray<{ readonly code: string }> }) => error.diagnostics.map(diagnostic => diagnostic.code));
    expect(codes).toEqual(["HOLQA_RUNTIME_START_FAILED", "HOLQA_SCHEDULE_INVALID"]);
    expect(runtime.state).toBe("stopped");
    // The application instance is free again.
    const retry = runtimeOf({ app, handlers: [scheduleHandler("nightly.run", "nightly", () => undefined)], binding: memoryBinding({ schedule: new ManualSchedule() }) });
    await retry.start();
    await retry.stop();
  });
});

describe("delivery options and metadata", () => {
  it.each([
    [{ concurrency: 0 }],
    [{ leaseMs: 1.5 }],
    [{ objectEvents: { maxAttempts: 0 } }],
    [{ objectEvents: { concurrency: -1 } }],
    [{ objectEvents: { backoff: { strategy: "linear" } } }],
    [{ objectEvents: { backoff: { strategy: "exponential", initialDelaySeconds: 5, maxDelaySeconds: 1 } } }],
    [{ objectEvents: { deadLetter: "yes" } }]
  ])("rejects invalid delivery options %p", (delivery) => {
    expect(() => runtimeOf({ app: application([queue()]), handlers: [], binding: memoryBinding({}), delivery: delivery as never })).toThrow("HOLQA_RUNTIME_START_FAILED");
  });

  it("checks the metadata of direct invocations against each trigger kind", async () => {
    const files: ResourceDescriptor = { protocol: 1, type: "resource", kind: "bucket", id: id("files"), config: {}, requirements: { access: "private" }, schemas: {} };
    const objectHandler = described({
      protocol: 1,
      type: "handler",
      definition: { id: id("files.created"), trigger: { kind: "bucket.object-created", resource: { kind: "bucket", id: id("files") }, options: {} } },
      schemas: { object: nonEmptyString },
      invoke: async () => undefined
    } as HandlerDescriptor);
    const runtime = runtimeOf({ app: application([queue(), files, { protocol: 1, type: "resource", kind: "schedule", id: id("nightly"), config: { cron: "0 3 * * *", timezone: "UTC" }, requirements: { overlap: "skip" }, schemas: {} }]), handlers: [consumer(() => undefined), objectHandler, scheduleHandler("nightly.run", "nightly", () => undefined)], binding: memoryBinding({}), manualTriggers: true });
    await runtime.start();
    /**
     * Invokes a handler and returns the failure code, or `ok`.
     *
     * @param handlerId - The handler to invoke directly.
     * @param metadata - The trusted metadata under test.
     * @returns The outcome's code.
     */
    const code = async (handlerId: string, metadata: object): Promise<string> => {
      const outcome = await runtime.invoke({ handlerId, input: "x", metadata });
      return outcome.ok ? "ok" : outcome.failure.code;
    };
    expect(await code("files.created", {})).toBe("HOLQA_INPUT_INVALID");
    expect(await code("files.created", { eventId: "e", eventTime: "t", attempt: 0 })).toBe("HOLQA_INPUT_INVALID");
    expect(await code("files.created", { eventId: "e", eventTime: "t", attempt: 1 })).toBe("ok");
    expect(await code("jobs.run", { attempt: 1, messageId: "m", schemaVersion: 0 })).toBe("HOLQA_INPUT_INVALID");
    expect(await code("jobs.run", { attempt: 1, messageId: "m", schemaVersion: 1 })).toBe("ok");
    expect(await code("nightly.run", { scheduledTime: "t", trigger: "hourly" })).toBe("HOLQA_INPUT_INVALID");
    expect(await code("nightly.run", { scheduledTime: "t", runId: 7 })).toBe("HOLQA_INPUT_INVALID");
    expect(await code("nightly.run", { scheduledTime: "t", runId: "r", trigger: "manual" })).toBe("ok");
    await runtime.stop();
  });
});