import type {
  OrderPlacedInput,
  OrderPlacedOutput
} from "@test/support/schemas";

import type { InputValidationError } from "@/schema/validate-input";
import type { DecodedMessage } from "@/wire/message-codec";

import { rejectionOf } from "@test/support/rejection";
import {
  anything,
  orderPlaced
} from "@test/support/schemas";
import {
  describe,
  expect,
  expectTypeOf,
  it
} from "bun:test";

import { HolqaError } from "@/errors/holqa-error";
import {
  createMessageCodec,
  prepareWirePayload
} from "@/wire/message-codec";
import {
  encodeMessageEnvelope,
  messageEnvelopeFormat
} from "@/wire/message-envelope";

const subject = "message for queue \"orders\"";

describe("createMessageCodec", () => {
  it("validates on publish and on receipt with one schema, keeping input and output types apart", async () => {
    const codec = createMessageCodec(orderPlaced, { schemaVersion: 1, subject });
    expectTypeOf<Parameters<typeof codec.encode>[0]>().toEqualTypeOf<OrderPlacedInput>();
    expectTypeOf<Awaited<ReturnType<typeof codec.decode>>>().toEqualTypeOf<DecodedMessage<OrderPlacedOutput>>();

    const bytes = await codec.encode({ orderId: "o_1", placedAt: "2026-10-18T09:00:00.000Z" });
    const text = new TextDecoder().decode(bytes);
    expect(JSON.parse(text)).toEqual({ format: "holqa.message/1", schemaVersion: 1, payload: { orderId: "o_1", placedAt: "2026-10-18T09:00:00.000Z" } });

    const decoded = await codec.decode(bytes);
    expect(decoded.message.placedAt).toBeInstanceOf(Date);
    expect(decoded.message.placedAt.toISOString()).toBe("2026-10-18T09:00:00.000Z");
    expect(decoded.schemaVersion).toBe(1);
    expect(decoded.payload).toEqual({ orderId: "o_1", placedAt: "2026-10-18T09:00:00.000Z" });
  });

  it("rejects an invalid message on publish with the failing field", async () => {
    const codec = createMessageCodec(orderPlaced, { schemaVersion: 1, subject });
    const error = await rejectionOf<InputValidationError>(codec.encode({ orderId: "o_1", placedAt: "yesterday" }));
    expect(error.code).toBe("HOLQA_INPUT_INVALID");
    expect(error.issues.map(issue => issue.path)).toEqual(["placedAt"]);
  });

  it("rejects an invalid message on receipt with the failing field", async () => {
    const codec = createMessageCodec(orderPlaced, { schemaVersion: 1, subject });
    const bytes = encodeMessageEnvelope({ format: messageEnvelopeFormat, schemaVersion: 1, payload: { orderId: 7, placedAt: "2026-10-18T09:00:00Z" } }, subject);
    const error = await rejectionOf<InputValidationError>(codec.decode(bytes));
    expect(error.code).toBe("HOLQA_INPUT_INVALID");
    expect(error.issues[0]).toMatchObject({ path: "orderId", pointer: "/orderId" });
  });

  it("never sends a schema's transformed output: a Date in the input is rejected, not stringified", async () => {
    const codec = createMessageCodec(anything, { schemaVersion: 1, subject });
    const error = await rejectionOf<HolqaError>(codec.encode({ placedAt: new Date(0) }));
    expect(error.code).toBe("HOLQA_PAYLOAD_NOT_SERIALIZABLE");
  });

  it("rejects messages produced with a schema version the consumer does not accept", async () => {
    const producer = createMessageCodec(orderPlaced, { schemaVersion: 2, subject });
    const consumer = createMessageCodec(orderPlaced, { schemaVersion: 3, subject });
    const bytes = await producer.encode({ orderId: "o_1", placedAt: "2026-10-18T09:00:00Z" });
    const error = await rejectionOf<HolqaError>(consumer.decode(bytes));
    expect(error.code).toBe("HOLQA_PAYLOAD_VERSION_UNSUPPORTED");

    const tolerant = createMessageCodec(orderPlaced, { schemaVersion: 3, subject, acceptedVersions: [2, 3] });
    expect((await tolerant.decode(bytes)).schemaVersion).toBe(2);
  });

  it("always accepts its own version", async () => {
    const codec = createMessageCodec(orderPlaced, { schemaVersion: 2, subject, acceptedVersions: [] });
    expect((await codec.decode(await codec.encode({ orderId: "o_1", placedAt: "2026-10-18T09:00:00Z" }))).schemaVersion).toBe(2);
  });

  it("rejects wrongly typed values at compile time", () => {
    const codec = createMessageCodec(orderPlaced, { schemaVersion: 1, subject });
    // @ts-expect-error The wire takes the input form; the decoded Date is the output form.
    void codec.encode({ orderId: "o_1", placedAt: new Date(0) }).catch(() => undefined);
    // @ts-expect-error A required field is missing.
    void prepareWirePayload(orderPlaced, { orderId: "o_1" }, subject).catch(() => undefined);
    /**
     * Never called: only its type-checking matters.
     *
     * @returns The pending call, which would reject at run time.
     */
    const notASchema = () => createMessageCodec(
      // @ts-expect-error Only Standard Schemas can back a codec.
      { parse: () => 1 },
      { schemaVersion: 1, subject }
    );
    expect(typeof notASchema).toBe("function");
    expectTypeOf<Awaited<ReturnType<typeof codec.decode>>["message"]["placedAt"]>().toEqualTypeOf<Date>();
  });

  it("records and reports the fingerprint", async () => {
    const codec = createMessageCodec(orderPlaced, { schemaVersion: 1, subject, fingerprint: "sha256:abc" });
    const decoded = await codec.decode(await codec.encode({ orderId: "o_1", placedAt: "2026-10-18T09:00:00Z" }));
    expect(decoded.fingerprint).toBe("sha256:abc");
  });

  it.each([0, -1, 1.5, Number.NaN])("rejects schema version %p", (schemaVersion) => {
    expect(() => createMessageCodec(orderPlaced, { schemaVersion, subject })).toThrow(HolqaError);
    expect(() => createMessageCodec(orderPlaced, { schemaVersion: 1, subject, acceptedVersions: [schemaVersion] })).toThrow("HOLQA_SCHEMA_VERSION_INVALID");
  });

  it("rejects envelopes that are not JSON", async () => {
    const codec = createMessageCodec(orderPlaced, { schemaVersion: 1, subject });
    const error = await rejectionOf<HolqaError>(codec.decode("not json"));
    expect(error.code).toBe("HOLQA_PAYLOAD_MALFORMED");
  });
});

describe("prepareWirePayload", () => {
  it("validates the transmitted copy, so omitted undefined properties are checked by the schema", async () => {
    const payload = await prepareWirePayload(orderPlaced, { orderId: "o_1", placedAt: "2026-10-18T09:00:00Z", note: undefined }, subject);
    expect(payload).toEqual({ orderId: "o_1", placedAt: "2026-10-18T09:00:00Z" });
  });
});