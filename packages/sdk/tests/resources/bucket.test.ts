import type { ObjectCreatedHandler } from "@/index";

import {
  bindApp,
  getAppDescriptor,
  getHandlerDescriptor,
  getResourceDescriptor,
  hasStandardJsonSchema
} from "@holqa/core";
import {
  createContext,
  createTestBinding,
  thrownCodes
} from "@test/support/test-binding";
import {
  describe,
  expect,
  expectTypeOf,
  it
} from "bun:test";

import {
  bucket,
  defineApp
} from "@/index";

describe("bucket", () => {
  it("declares its access policy as a requirement", () => {
    const uploads = bucket({ id: "uploads", access: "public-read" });
    expect(getResourceDescriptor(uploads)?.requirements).toEqual({ access: "public-read" });
    expectTypeOf(uploads.id).toEqualTypeOf<"uploads">();
  });

  it("rejects unknown access policies", () => {
    /** Holds deliberate type errors checked by tsc; never executed. */
    const neverCalled = (): void => {
      // @ts-expect-error -- "public" is not an access policy.
      bucket({ id: "open", access: "public" });
      // @ts-expect-error -- `access` is required.
      bucket({ id: "none" });
    };
    expect(typeof neverCalled).toBe("function");
    expect(thrownCodes(() => bucket({ id: "open", access: "public" } as never))).toEqual(["HOLQA_DECLARATION_INVALID"]);
  });

  it("stores and reads objects through the bound runtime only", async () => {
    const files = bucket({ id: "files", access: "private" });
    const app = defineApp({ name: "storage", resources: { files } });
    expect(await files.get("a.txt").catch((error: unknown) => (error as { code: string }).code)).toBe("HOLQA_RUNTIME_NOT_BOUND");
    const unbind = bindApp(getAppDescriptor(app)!, createTestBinding());
    try {
      await files.put("a.txt", "hello", { contentType: "text/plain" });
      expect(new TextDecoder().decode(await files.get("a.txt"))).toBe("hello");
    } finally {
      unbind();
    }
  });

  it("registers object-created handlers that validate the portable event", async () => {
    const images = bucket({ id: "images", access: "private" });
    const seen: string[] = [];
    const handler = images.onObjectCreated({ id: "images.thumbnail", prefix: "raw/", handler: ({ object }) => {
      seen.push(`${object.key}:${object.size}`);
    } });
    expectTypeOf(handler).toEqualTypeOf<ObjectCreatedHandler<"images", "images.thumbnail">>();
    expect<unknown>(getHandlerDescriptor(handler)?.definition).toEqual({
      id: "images.thumbnail",
      trigger: { kind: "bucket.object-created", resource: { kind: "bucket", id: "images" }, options: { prefix: "raw/" } }
    });
    await handler["~holqa"].invoke({ key: "raw/a.png", size: 3 }, createContext({}));
    expect(seen).toEqual(["raw/a.png:3"]);
    expect(await handler["~holqa"].invoke({ key: "", size: -1 }, createContext({})).catch((error: unknown) => (error as { code: string }).code)).toBe("HOLQA_INPUT_INVALID");
  });

  it("describes the portable event with Standard JSON Schema, so compilers can record it", () => {
    const handler = bucket({ id: "images", access: "private" }).onObjectCreated({ id: "images.thumbnail", handler: () => {} });
    const schema = handler["~holqa"].schemas.object;
    if (!hasStandardJsonSchema(schema))
      throw new Error("Expected the object event schema to implement Standard JSON Schema.");
    expect(schema["~standard"].vendor).toBe("holqa");
    expect(schema["~standard"].jsonSchema.input({ target: "draft-2020-12" })).toEqual({
      type: "object",
      properties: { key: { type: "string", minLength: 1 }, size: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER }, contentType: { type: "string" } },
      required: ["key", "size"]
    });
    expect(schema["~standard"].jsonSchema.output({ target: "draft-2020-12" })).toMatchObject({ additionalProperties: false });
  });
});