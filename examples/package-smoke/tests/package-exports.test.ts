import type {
  Diagnostic,
  ResourceId,
  StandardSchemaV1
} from "@holqa/core";
import type { QueueMessageInput } from "@holqa/sdk";
import type {
  Equal,
  Expect
} from "@holqa/testing";

import {
  canonicalJsonStringify,
  checkSchemaCompatibility,
  describeSchemaContract
} from "@holqa/compiler";
import {
  createMessageCodec,
  getAppDescriptor,
  parseResourceId
} from "@holqa/core";
import {
  defineApp,
  queue
} from "@holqa/sdk";
import { assertType } from "@holqa/testing";
import { zodAdapter } from "@holqa/zod";
import {
  describe,
  expect,
  expectTypeOf,
  it
} from "bun:test";
import { z } from "zod";

describe("@holqa/core public exports", () => {
  it("validates resource identifiers through the built package", () => {
    const result = parseResourceId("order-processing");
    expect(result.ok).toBe(true);
    if (result.ok)
      expectTypeOf(result.value).toEqualTypeOf<ResourceId>();
    else
      expectTypeOf(result.error).toEqualTypeOf<Diagnostic>();
  });
});

describe("@holqa/compiler public exports", () => {
  it("serializes deterministically through the built package", () => {
    expect(canonicalJsonStringify({ b: 1, a: 2 })).toBe("{\n  \"a\": 2,\n  \"b\": 1\n}");
  });
});

/** A dependency-free Standard Schema for a number, so the smoke test needs no schema library. */
const count: StandardSchemaV1<number> = {
  "~standard": {
    version: 1,
    vendor: "smoke",
    validate: value => typeof value === "number" ? { value } : { issues: [{ message: "Expected a number." }] }
  }
};

describe("@holqa/sdk public exports", () => {
  it("defines an application whose handle types survive the built declarations", () => {
    const app = defineApp({ name: "smoke", resources: { counts: queue({ id: "counts", message: count, schemaVersion: 1 }) } });
    expectTypeOf(app.resources.counts.id).toEqualTypeOf<"counts">();
    expectTypeOf<QueueMessageInput<typeof app.resources.counts>>().toEqualTypeOf<number>();
    expect(getAppDescriptor(app)?.resources.map(resource => resource.kind)).toEqual(["queue"]);
  });
});

describe("schema contracts through the built packages", () => {
  it("encodes and decodes a versioned message with @holqa/core", async () => {
    const codec = createMessageCodec(count, { schemaVersion: 1, subject: "count" });
    expect((await codec.decode(await codec.encode(3))).message).toBe(3);
  });

  it("describes, fingerprints and compares Zod contracts with @holqa/zod and @holqa/compiler", async () => {
    const options = { subject: "message", schemaVersion: 1, adapters: [zodAdapter] };
    const previous = await describeSchemaContract(z.object({ id: z.string() }), options);
    const next = await describeSchemaContract(z.object({ id: z.string(), customer: z.string() }), options);
    if (!previous.ok || !next.ok)
      throw new Error("Expected both schemas to be described.");
    expect(previous.value.record.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    const report = checkSchemaCompatibility(previous.value.record, next.value.record, { role: "message", subject: "message" });
    expect(report.diagnostics.map(diagnostic => diagnostic.code)).toEqual(["HOLQA_SCHEMA_CHANGE_BREAKING"]);
  });
});

/** Compile-time assertion through the built @holqa/testing declarations; checked by tsc. */
export type SmokeAssertion = Expect<Equal<ReturnType<typeof parseResourceId>["ok"], boolean>>;

describe("@holqa/testing public exports", () => {
  it("exposes type assertions with no run-time effect", () => {
    expect(assertType<string>("smoke")).toBeUndefined();
  });
});