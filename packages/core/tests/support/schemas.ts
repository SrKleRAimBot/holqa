import type { StandardSchemaV1 } from "@/schema/standard-schema";

/** The input (wire) form of {@link orderPlaced}. */
export interface OrderPlacedInput {
  readonly orderId: string;
  readonly placedAt: string;
  readonly note?: string | undefined;
}

/** The output (decoded) form of {@link orderPlaced}: `placedAt` becomes a `Date`. */
export interface OrderPlacedOutput {
  readonly orderId: string;
  readonly placedAt: Date;
  readonly note?: string;
}

/**
 * A hand-written Standard Schema that, like a Zod codec, accepts an ISO string
 * and produces a `Date`. Used to show that the wire carries the input form.
 */
export const orderPlaced: StandardSchemaV1<OrderPlacedInput, OrderPlacedOutput> = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: (value) => {
      if (typeof value !== "object" || value === null)
        return { issues: [{ message: "Expected an object." }] };
      const { orderId, placedAt, note } = value as Record<string, unknown>;
      const issues: { message: string; path: string[] }[] = [];
      if (typeof orderId !== "string")
        issues.push({ message: "Expected a string.", path: ["orderId"] });
      if (typeof placedAt !== "string" || Number.isNaN(Date.parse(placedAt)))
        issues.push({ message: "Expected an ISO date-time string.", path: ["placedAt"] });
      if (note !== undefined && typeof note !== "string")
        issues.push({ message: "Expected a string.", path: ["note"] });
      if (issues.length > 0)
        return { issues };
      return {
        value: {
          orderId: orderId as string,
          placedAt: new Date(placedAt as string),
          ...(note === undefined ? {} : { note: note as string })
        }
      };
    }
  }
};

/** A schema that accepts any value unchanged, so tests can reach the encoder with any input. */
export const anything: StandardSchemaV1<unknown, unknown> = {
  "~standard": { version: 1, vendor: "test", validate: value => ({ value }) }
};