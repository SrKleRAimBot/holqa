import type {
  DecodedMessage,
  InputValidationError,
  PayloadError
} from "@holqa/core";

import {
  createMessageCodec,
  validateInput
} from "@holqa/core";
import {
  describe,
  expect,
  expectTypeOf,
  it
} from "bun:test";
import { z } from "zod";

/** An order message whose wire form carries an ISO string and whose decoded form carries a Date. */
const orderPlaced = z.object({
  orderId: z.string().min(1),
  placedAt: z.codec(z.iso.datetime(), z.date(), { decode: text => new Date(text), encode: date => date.toISOString() }),
  lines: z.array(z.object({ sku: z.string(), quantity: z.int().min(1) })).min(1),
  priority: z.enum(["normal", "urgent"]).default("normal")
});

const subject = "message for queue \"orders\"";

/**
 * Awaits a promise that must reject and returns the reason.
 *
 * @param promise - The promise expected to reject.
 * @returns The rejection reason.
 */
async function rejectionOf<E>(promise: Promise<unknown>): Promise<E> {
  try {
    await promise;
  } catch (error) {
    return error as E;
  }
  throw new Error("Expected the promise to reject.");
}

describe("one Zod schema on both ends of the wire", () => {
  const codec = createMessageCodec(orderPlaced, { schemaVersion: 1, subject });

  it("types publish with the input and receipt with the decoded output", () => {
    expectTypeOf<Parameters<typeof codec.encode>[0]>().toEqualTypeOf<z.input<typeof orderPlaced>>();
    expectTypeOf<Awaited<ReturnType<typeof codec.decode>>>().toEqualTypeOf<DecodedMessage<z.output<typeof orderPlaced>>>();
    expectTypeOf<z.input<typeof orderPlaced>["placedAt"]>().toEqualTypeOf<string>();
    expectTypeOf<z.output<typeof orderPlaced>["placedAt"]>().toEqualTypeOf<Date>();
    /**
     * Never called: only its type-checking matters.
     *
     * @returns The pending call, which would reject at run time.
     */
    const encodeDecoded = () => codec.encode({
      orderId: "o_1",
      // @ts-expect-error The wire carries the ISO string, not the decoded Date.
      placedAt: new Date(0),
      lines: [{ sku: "SKU-1", quantity: 1 }]
    });
    expect(typeof encodeDecoded).toBe("function");
  });

  it("sends the input form and decodes the output form", async () => {
    const bytes = await codec.encode({ orderId: "o_1", placedAt: "2026-10-18T09:00:00Z", lines: [{ sku: "SKU-1", quantity: 2 }] });
    const envelope = JSON.parse(new TextDecoder().decode(bytes)) as { payload: Record<string, unknown> };
    expect(envelope.payload).toEqual({ orderId: "o_1", placedAt: "2026-10-18T09:00:00Z", lines: [{ sku: "SKU-1", quantity: 2 }] });

    const { message } = await codec.decode(bytes);
    expect(message.placedAt).toBeInstanceOf(Date);
    expect(message.priority).toBe("normal");
  });

  it("names exactly which field failed on receipt", async () => {
    const tampered = JSON.stringify({ format: "holqa.message/1", schemaVersion: 1, payload: { orderId: "o_1", placedAt: "2026-10-18T09:00:00Z", lines: [{ sku: "SKU-1", quantity: 0 }] } });
    const error = await rejectionOf<InputValidationError>(codec.decode(tampered));
    expect(error.code).toBe("HOLQA_INPUT_INVALID");
    expect(error.issues).toEqual([{
      message: expect.any(String),
      path: "lines.0.quantity",
      segments: ["lines", 0, "quantity"],
      pointer: "/lines/0/quantity",
      details: { origin: "number", code: "too_small", minimum: 1, inclusive: true }
    }]);
  });

  it("refuses to put a Date on the wire even though the decoded type has one", async () => {
    const error = await rejectionOf<PayloadError>(codec.encode({ orderId: "o_1", placedAt: new Date() as unknown as string, lines: [{ sku: "SKU-1", quantity: 1 }] }));
    expect(error.code).toBe("HOLQA_PAYLOAD_NOT_SERIALIZABLE");
    expect(error.path).toBe("$.placedAt");
  });

  it("never copies the rejected input into issue details", async () => {
    const error = await rejectionOf<InputValidationError>(validateInput(z.string(), { secret: "do-not-log" }, "value"));
    expect(JSON.stringify(error.diagnostics)).not.toContain("do-not-log");
  });
});