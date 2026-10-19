import type {
  HandlerDefinition,
  ResourceDescriptor
} from "@holqa/core";

import { diagnosticsOf } from "@holqa/core";
import {
  application,
  bucketResource,
  consumer,
  objectHandler,
  queueResource,
  scheduleResource,
  sequentialIds
} from "@test/support/fixtures";
import {
  describe,
  expect,
  it
} from "bun:test";

import { manualTriggerMetadata } from "@/manual-trigger";

/** The application every case uses. */
const app = application([{ ...queueResource("jobs"), config: { schemaVersion: 3 } } as ResourceDescriptor, bucketResource("files"), scheduleResource("nightly", "0 3 * * *")]);

/** 2026-10-18T09:00:00Z. */
const now = Date.parse("2026-10-18T09:00:00.000Z");

/** A fixture handler, carrying its descriptor under `~holqa`. */
interface Registration { readonly "~holqa": { readonly definition: HandlerDefinition } }

/**
 * Reads the definition of a fixture handler.
 *
 * @param registration - A fixture handler.
 * @returns Its definition.
 */
function definitionOf(registration: Registration): HandlerDefinition {
  return registration["~holqa"].definition;
}

describe("manualTriggerMetadata", () => {
  it("describes a first delivery of a new message, with the queue's schema version", () => {
    const definition = definitionOf(consumer("jobs.run", "jobs", () => {}));
    expect(manualTriggerMetadata(app, definition, { now, createId: sequentialIds("m-") })).toEqual({ attempt: 1, messageId: "m-1", schemaVersion: 3 });
    expect(manualTriggerMetadata(app, definition, { now, createId: sequentialIds(), attempt: 3, messageId: "known" })).toEqual({ attempt: 3, messageId: "known", schemaVersion: 3 });
  });

  it("describes a new object event and a manual scheduled run at the given time", () => {
    const created = definitionOf(objectHandler("files.created", "files", "bucket.object-created", () => {}));
    expect(manualTriggerMetadata(app, created, { now, createId: sequentialIds("e-") })).toEqual({ eventId: "e-1", eventTime: "2026-10-18T09:00:00.000Z", attempt: 1 });
    const nightly: HandlerDefinition = { id: "nightly.run", trigger: { kind: "schedule.tick", resource: { kind: "schedule", id: "nightly" }, options: {} } } as HandlerDefinition;
    expect(manualTriggerMetadata(app, nightly, { now, createId: sequentialIds("r-") })).toEqual({ scheduledTime: "2026-10-18T09:00:00.000Z", runId: "r-1", trigger: "manual" });
  });

  it("refuses HTTP handlers and invalid attempts", () => {
    const route = { id: "orders.get", trigger: { kind: "http.route", resource: { kind: "http.api", id: "api" }, options: { method: "GET", path: "/orders" } } } as HandlerDefinition;
    /**
     * Collects the codes a call throws.
     *
     * @param call - The call expected to throw.
     * @returns The diagnostic codes.
     */
    const codes = (call: () => unknown): string[] => {
      try {
        call();
        return [];
      } catch (error) {
        return diagnosticsOf(error).map(diagnostic => diagnostic.code);
      }
    };
    expect(codes(() => manualTriggerMetadata(app, route, { now, createId: sequentialIds() }))).toEqual(["HOLQA_OPERATION_INVALID"]);
    expect(codes(() => manualTriggerMetadata(app, definitionOf(consumer("jobs.run", "jobs", () => {})), { now, createId: sequentialIds(), attempt: 0 }))).toEqual(["HOLQA_OPERATION_INVALID"]);
    expect(codes(() => manualTriggerMetadata({}, route, { now, createId: sequentialIds() }))).toEqual(["HOLQA_APP_INVALID"]);
  });
});