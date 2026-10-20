import type {
  AppDescriptor,
  BucketDriver,
  DriverOperationContext,
  ResourceDescriptor,
  RuntimeBinding
} from "@holqa/core";

import { resolveDriver } from "@holqa/core";
import {
  application,
  id,
  nonEmptyString,
  queueResource,
  recordingSink,
  scheduleHandler,
  scheduleResource,
  sequentialIds
} from "@test/support/descriptors";
import {
  describe,
  expect,
  it
} from "bun:test";

import { createRuntime } from "@/runtime/create-runtime";

/** A bucket descriptor. */
const files: ResourceDescriptor = { protocol: 1, type: "resource", kind: "bucket", id: id("files"), config: {}, requirements: { access: "private" }, schemas: {} };

/** Metadata of a scheduled run. */
const tick = { scheduledTime: "2026-10-18T03:00:00Z" };

/** What the recording binding's drivers received. */
interface Calls {
  readonly sends: Array<DriverOperationContext | undefined>;
  readonly writes: Array<{ readonly operation: string; readonly key: string; readonly context: DriverOperationContext | undefined }>;
}

/**
 * Creates a binding whose drivers record the context of every operation.
 *
 * @returns The binding and the recorded calls.
 */
function recordingBinding(): { readonly binding: RuntimeBinding; readonly calls: Calls } {
  const calls: Calls = { sends: [], writes: [] };
  const bucket: BucketDriver = {
    put: async (key, body, _options, context) => {
      calls.writes.push({ operation: "put", key, context });
      return { key, size: body.length, etag: "e", lastModified: "2026-10-18T03:00:00.000Z" };
    },
    delete: async (key, context) => {
      calls.writes.push({ operation: "delete", key, context });
      return key !== "missing";
    },
    get: async () => undefined,
    head: async () => undefined,
    list: async () => ({ objects: [] }),
    signUrl: async () => {
      throw new Error("not used");
    }
  };
  return {
    calls,
    binding: {
      name: "recording",
      capabilities: {
        queue: { delivery: ["at-least-once"], maxAttempts: 10, deadLetter: true, backoff: ["fixed", "exponential"], maxDelaySeconds: 900 },
        bucket: { access: ["private"] },
        schedule: { overlap: ["skip"] }
      },
      drivers: {
        queue: () => ({
          send: async (_envelope, _options, context) => {
            calls.sends.push(context);
            return { messageId: `m-${calls.sends.length}` };
          }
        }),
        bucket: () => bucket
      },
      config: () => undefined
    }
  };
}

describe("traced drivers", () => {
  it("passes the invocation's trace to drivers and reports what the handler emitted", async () => {
    const jobs = { ...queueResource("jobs"), schemas: { message: nonEmptyString } } as ResourceDescriptor;
    const app = application([jobs, files, scheduleResource("nightly")]);
    const descriptor: AppDescriptor = app["~holqa"];
    const { binding, calls } = recordingBinding();
    const { sink, entries } = recordingSink();
    const handler = scheduleHandler("nightly.run", "nightly", async () => {
      await resolveDriver(descriptor, jobs as ResourceDescriptor & { kind: "queue" }, "send").send({ format: "holqa.message/1", schemaVersion: 1, payload: "a" }, {});
      const bucket = resolveDriver(descriptor, files as ResourceDescriptor & { kind: "bucket" }, "put");
      await bucket.put("report.txt", new Uint8Array([1]), {});
      await bucket.delete("old.txt");
      await bucket.delete("missing");
    });
    const runtime = createRuntime({ app, handlers: [handler], binding, manualTriggers: true, log: sink, createId: sequentialIds() });
    await runtime.start();
    const outcome = await runtime.invoke({ handlerId: "nightly.run", metadata: tick, correlationId: "trace-1" });
    await runtime.stop();

    expect(outcome.ok).toBe(true);
    const trace = { trace: { correlationId: "trace-1", causationId: outcome.invocationId, rootId: outcome.invocationId, depth: 1 } };
    expect(calls.sends).toEqual([trace]);
    expect(calls.writes).toEqual([
      { operation: "put", key: "report.txt", context: trace },
      { operation: "delete", key: "old.txt", context: trace },
      { operation: "delete", key: "missing", context: trace }
    ]);
    // A delete of a missing object changes nothing, so it is not reported.
    expect(outcome.emitted).toEqual([
      { type: "queue.message", resourceId: "jobs", messageId: "m-1" },
      { type: "object.created", resourceId: "files", key: "report.txt" },
      { type: "object.deleted", resourceId: "files", key: "old.txt" }
    ]);
    expect(entries.find(entry => entry.message === "invocation completed")).toMatchObject({ triggerKind: "schedule.tick", resourceId: "nightly", emitted: outcome.emitted });
  });

  it("passes operations outside an invocation through without a trace", async () => {
    const jobs = { ...queueResource("jobs"), schemas: { message: nonEmptyString } } as ResourceDescriptor;
    const app = application([jobs]);
    const { binding, calls } = recordingBinding();
    const runtime = createRuntime({ app, handlers: [], binding, log: () => {} });
    await runtime.start();
    await resolveDriver(app["~holqa"], jobs as ResourceDescriptor & { kind: "queue" }, "send").send({ format: "holqa.message/1", schemaVersion: 1, payload: "a" }, {});
    await runtime.stop();
    expect(calls.sends).toEqual([undefined]);
  });

  it("logs where a failing handler is implemented", async () => {
    const { binding } = recordingBinding();
    const { sink, entries } = recordingSink();
    const runtime = createRuntime({
      app: application([scheduleResource("nightly")]),
      handlers: [scheduleHandler("nightly.run", "nightly", () => {
        throw new Error("boom");
      })],
      handlerSources: { "nightly.run": "src/nightly.handler.ts#run" },
      binding,
      manualTriggers: true,
      log: sink
    });
    await runtime.start();
    const outcome = await runtime.invoke({ handlerId: "nightly.run", metadata: tick, causationId: "parent-1" });
    await runtime.stop();
    expect(outcome).toMatchObject({ ok: false, emitted: [] });
    expect(entries.find(entry => entry.message === "invocation failed")).toMatchObject({ causationId: "parent-1", source: "src/nightly.handler.ts#run", code: "HOLQA_HANDLER_FAILED", error: { message: "boom" } });
  });
});