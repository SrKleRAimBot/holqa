import {
  describe,
  expect,
  it
} from "bun:test";

import {
  objectEventFormat,
  readObjectEvent
} from "@/storage/object-event";
import { PayloadError } from "@/wire/json-payload";

/** A valid object.created event. */
const created = {
  format: objectEventFormat,
  id: "evt-1",
  type: "object.created",
  bucket: "uploads",
  time: "2026-10-18T09:00:00.000Z",
  object: { key: "incoming/a.txt", size: 12, contentType: "text/plain", etag: "abc" }
};

/**
 * Reads an event that must be rejected and returns the offending JSON path.
 *
 * @param value - The malformed event.
 * @returns The path the error names.
 */
function rejectedPath(value: unknown): string {
  try {
    readObjectEvent(value, "event");
  } catch (error) {
    if (error instanceof PayloadError) {
      expect(error.code).toBe("HOLQA_PAYLOAD_MALFORMED");
      return error.path;
    }
    throw error;
  }
  throw new Error("The event was accepted.");
}

describe("readObjectEvent", () => {
  it("returns a frozen copy without unknown properties", () => {
    const event = readObjectEvent({ ...created, extra: true, object: { ...created.object, providerField: 1 } }, "event");
    expect(event).toEqual(created as never);
    expect(Object.isFrozen(event)).toBe(true);
    expect(Object.isFrozen(event.object)).toBe(true);
  });

  it("accepts deleted events without a size", () => {
    expect(readObjectEvent({ ...created, type: "object.deleted", object: { key: "a" } }, "event").object).toEqual({ key: "a" });
  });

  it.each([
    [null, "$"],
    [{ ...created, format: "other/1" }, "$.format"],
    [{ ...created, id: "" }, "$.id"],
    [{ ...created, type: "object.updated" }, "$.type"],
    [{ ...created, bucket: 1 }, "$.bucket"],
    [{ ...created, time: "yesterday" }, "$.time"],
    [{ ...created, time: "2026-10-18T09:00:00+02:00" }, "$.time"],
    [{ ...created, object: [] }, "$.object"],
    [{ ...created, object: { size: 1 } }, "$.object.key"],
    [{ ...created, object: { key: "a", size: -1 } }, "$.object.size"],
    [{ ...created, object: { key: "a" } }, "$.object.size"],
    [{ ...created, object: { key: "a", size: 1, contentType: 1 } }, "$.object.contentType"],
    [{ ...created, object: { key: "a", size: 1, etag: 1 } }, "$.object.etag"]
  ])("rejects %p at %p", (value, path) => {
    expect(rejectedPath(value)).toBe(path);
  });
});