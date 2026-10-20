import type {
  HandlerDefinition,
  ResourceDescriptorOf,
  RuntimeBinding
} from "@/index";

import {
  appDescriptor,
  id,
  queueDescriptor,
  recordingBinding,
  scheduleDescriptor
} from "@test/support/descriptors";
import {
  describe,
  expect,
  it
} from "bun:test";

import { checkTriggerDelivery } from "@/binding/delivery-check";

/**
 * Builds a handler definition for a trigger kind.
 *
 * @param kind - The trigger kind.
 * @param resourceId - The resource it belongs to.
 * @returns The definition.
 */
function handler(kind: HandlerDefinition["trigger"]["kind"], resourceId: string): HandlerDefinition {
  const resourceKind = kind === "queue.message" ? "queue" : kind === "schedule.tick" ? "schedule" : kind.startsWith("bucket.") ? "bucket" : "http.api";
  return { id: id(`${resourceId}.handler`), trigger: { kind, resource: { kind: resourceKind, id: id(resourceId) }, options: kind === "http.route" ? { method: "GET", path: "/" } : kind === "http.procedure" ? { operation: "query" } : {} } } as HandlerDefinition;
}

/** A binding with every source and full queue delays. */
const delivering: RuntimeBinding = {
  ...recordingBinding({ queue: { delivery: ["at-least-once"], maxAttempts: 10, deadLetter: true, maxDelaySeconds: 900 }, bucket: { access: ["private"], events: ["object.created"] } }),
  sources: {
    queue: () => {
      throw new Error("not used");
    },
    bucket: () => {
      throw new Error("not used");
    },
    schedule: () => {
      throw new Error("not used");
    }
  }
};

describe("checkTriggerDelivery", () => {
  it("accepts handlers the binding can deliver, and HTTP handlers without a source", () => {
    const app = appDescriptor([queueDescriptor("jobs"), scheduleDescriptor("nightly")]);
    expect(checkTriggerDelivery(app, [handler("queue.message", "jobs"), handler("schedule.tick", "nightly"), handler("bucket.object-created", "files"), handler("http.route", "api")], delivering)).toEqual([]);
  });

  it("reports missing sources and undelivered event types, one diagnostic per handler", () => {
    const app = appDescriptor([queueDescriptor("jobs")]);
    const problems = checkTriggerDelivery(app, [handler("queue.message", "jobs"), handler("schedule.tick", "nightly"), handler("bucket.object-deleted", "files")], recordingBinding());
    expect(problems.map(problem => [problem.code, problem.details])).toEqual([
      ["HOLQA_BINDING_CAPABILITY_UNSUPPORTED", { handler: "jobs.handler", trigger: "queue.message", binding: "recording", requirement: "trigger.queue.message" }],
      ["HOLQA_BINDING_CAPABILITY_UNSUPPORTED", { handler: "nightly.handler", trigger: "schedule.tick", binding: "recording", requirement: "trigger.schedule.tick" }],
      ["HOLQA_BINDING_CAPABILITY_UNSUPPORTED", { handler: "files.handler", trigger: "bucket.object-deleted", binding: "recording", requirement: "trigger.bucket.object-deleted" }]
    ]);
    expect(checkTriggerDelivery(app, [handler("bucket.object-deleted", "files")], delivering).map(problem => problem.message)).toEqual([
      "Binding \"recording\" cannot deliver bucket.object-deleted triggers to the handler \"files.handler\": it does not deliver object.deleted events."
    ]);
  });

  it("checks the default backoff only for queues that declare none", () => {
    const limited: RuntimeBinding = { ...delivering, capabilities: { ...delivering.capabilities, queue: { delivery: ["at-least-once"], maxAttempts: 10, deadLetter: true, maxDelaySeconds: 60 } } };
    expect(checkTriggerDelivery(appDescriptor([queueDescriptor("jobs")]), [handler("queue.message", "jobs")], limited)).toHaveLength(1);
    expect(checkTriggerDelivery(appDescriptor([queueDescriptor("jobs", { backoff: { strategy: "fixed", delaySeconds: 30 } })]), [handler("queue.message", "jobs")], limited)).toEqual([]);
  });

  it("compares each resource with the provider a composed binding selected for it", () => {
    const files: ResourceDescriptorOf<"bucket"> = { protocol: 1, type: "resource", kind: "bucket", id: id("files"), config: {}, requirements: { access: "private" }, schemas: {} };
    const app = appDescriptor([queueDescriptor("jobs"), files]);
    const composed: RuntimeBinding = {
      ...delivering,
      describe: resource => resource.id === "files"
        ? { binding: "storage-without-events", capabilities: { bucket: { access: ["private"] } } }
        : { binding: "short-delays", capabilities: { queue: { delivery: ["at-least-once"], maxAttempts: 10, deadLetter: true, maxDelaySeconds: 30 } } }
    };
    expect(checkTriggerDelivery(app, [handler("queue.message", "jobs"), handler("bucket.object-created", "files")], composed).map(problem => problem.message)).toEqual([
      "Binding \"short-delays\" cannot deliver queue.message triggers to the handler \"jobs.handler\": the default backoff delays redeliveries by up to 300 seconds but the binding supports at most 30; declare a backoff it supports.",
      "Binding \"storage-without-events\" cannot deliver bucket.object-created triggers to the handler \"files.handler\": it does not deliver object.created events."
    ]);
  });
});