import type { PayloadError } from "@/wire/json-payload";

import {
  describe,
  expect,
  it
} from "bun:test";

import {
  decodeMessageEnvelope,
  encodeMessageEnvelope,
  messageEnvelopeFormat
} from "@/wire/message-envelope";

/**
 * Decodes text that must be rejected and returns the error.
 *
 * @param text - The envelope text.
 * @returns The thrown payload error.
 */
function rejection(text: string): PayloadError {
  try {
    decodeMessageEnvelope(text, "test");
  } catch (error) {
    return error as PayloadError;
  }
  throw new Error("Expected the envelope to be rejected.");
}

describe("message envelopes", () => {
  it("round-trip the payload, schema version and fingerprint", () => {
    const bytes = encodeMessageEnvelope({ format: messageEnvelopeFormat, schemaVersion: 2, fingerprint: "sha256:abc", payload: { a: 1 } }, "test");
    expect(decodeMessageEnvelope(bytes, "test")).toEqual({ format: "holqa.message/1", schemaVersion: 2, fingerprint: "sha256:abc", payload: { a: 1 } });
  });

  it("omits an absent fingerprint", () => {
    const decoded = decodeMessageEnvelope(encodeMessageEnvelope({ format: messageEnvelopeFormat, schemaVersion: 1, payload: null }, "test"), "test");
    expect("fingerprint" in decoded).toBe(false);
    expect(decoded.payload).toBeNull();
  });

  it("ignores unknown envelope properties", () => {
    expect(decodeMessageEnvelope("{\"format\":\"holqa.message/1\",\"schemaVersion\":1,\"payload\":1,\"future\":true}", "test").payload).toBe(1);
  });

  it.each([
    ["[]", "$"],
    ["{\"schemaVersion\":1,\"payload\":1}", "$.format"],
    ["{\"format\":\"holqa.message/2\",\"schemaVersion\":1,\"payload\":1}", "$.format"],
    ["{\"format\":\"holqa.message/1\",\"schemaVersion\":0,\"payload\":1}", "$.schemaVersion"],
    ["{\"format\":\"holqa.message/1\",\"schemaVersion\":1.5,\"payload\":1}", "$.schemaVersion"],
    ["{\"format\":\"holqa.message/1\",\"schemaVersion\":1,\"fingerprint\":1,\"payload\":1}", "$.fingerprint"],
    ["{\"format\":\"holqa.message/1\",\"schemaVersion\":1}", "$.payload"]
  ])("rejects %s at %s", (text, path) => {
    const error = rejection(text);
    expect(error.code).toBe("HOLQA_PAYLOAD_MALFORMED");
    expect(error.path).toBe(path);
  });
});