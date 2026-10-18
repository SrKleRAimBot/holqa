import type {
  ObjectMetadata,
  SignedUrl
} from "@holqa/core";

import type {
  DeletedObjectInfo,
  ObjectCreatedContext,
  ObjectCreatedHandler,
  ObjectDeletedContext,
  ObjectDeletedHandler,
  ObjectEventInfo
} from "@/index";

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
    await handler["~holqa"].invoke({ key: "raw/a.png", size: 3 }, createContext({ eventId: "e-1", eventTime: "2026-10-18T00:00:00.000Z", attempt: 1 }));
    expect(seen).toEqual(["raw/a.png:3"]);
    expect(await handler["~holqa"].invoke({ key: "", size: -1 }, createContext({ eventId: "e-1", eventTime: "2026-10-18T00:00:00.000Z", attempt: 1 })).catch((error: unknown) => (error as { code: string }).code)).toBe("HOLQA_INPUT_INVALID");
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

  it("lists, inspects, deletes and signs objects through the bound runtime", async () => {
    const files = bucket({ id: "files", access: "private" });
    const app = defineApp({ name: "objects", resources: { files } });
    const unbind = bindApp(getAppDescriptor(app)!, createTestBinding());
    try {
      expect(await files.put("docs/a.txt", "hello")).toMatchObject({ key: "docs/a.txt", size: 5 });
      await files.put("docs/b.txt", new Uint8Array([1, 2]));
      expect(await files.head("docs/b.txt")).toMatchObject({ size: 2 });
      expect((await files.list({ prefix: "docs/", limit: 1 })).objects.map(object => object.key)).toEqual(["docs/a.txt"]);
      expect(await files.delete("docs/a.txt")).toBe(true);
      expect(await files.delete("docs/a.txt")).toBe(false);
      expect(await files.head("docs/a.txt")).toBeUndefined();
      expect(await files.signedUrl("docs/b.txt", { method: "GET", expiresInSeconds: 60 })).toMatchObject({ method: "GET" });
    } finally {
      unbind();
    }
  });

  it("rejects invalid keys and options before the driver sees them", async () => {
    const files = bucket({ id: "files", access: "private" });
    const app = defineApp({ name: "checks", resources: { files } });
    const binding = createTestBinding({}, { bucket: { access: ["private"], signedUrls: { maxExpiresInSeconds: 600 } } });
    const unbind = bindApp(getAppDescriptor(app)!, binding);
    /**
     * Runs an operation that must fail and returns the error code.
     *
     * @param run - The operation.
     * @returns The code of the thrown error.
     */
    const code = async (run: () => Promise<unknown>): Promise<string> => run().then(() => "accepted", (error: { readonly code: string }) => error.code);
    try {
      expect(await code(() => files.put("../escape", "x"))).toBe("HOLQA_OBJECT_KEY_INVALID");
      expect(await code(() => files.get("/abs"))).toBe("HOLQA_OBJECT_KEY_INVALID");
      expect(await code(() => files.put("a", 42 as never))).toBe("HOLQA_OPERATION_INVALID");
      expect(await code(() => files.put("a", "x", { contentType: "" }))).toBe("HOLQA_OPERATION_INVALID");
      expect(await code(() => files.list({ limit: 1001 }))).toBe("HOLQA_OPERATION_INVALID");
      expect(await code(() => files.list({ cursor: "" }))).toBe("HOLQA_OPERATION_INVALID");
      expect(await code(() => files.signedUrl("a", { method: "DELETE" as never, expiresInSeconds: 60 }))).toBe("HOLQA_OPERATION_INVALID");
      expect(await code(() => files.signedUrl("a", { method: "GET", expiresInSeconds: 60, contentType: "text/plain" }))).toBe("HOLQA_OPERATION_INVALID");
      expect(await code(() => files.signedUrl("a", { method: "GET", expiresInSeconds: 601 }))).toBe("HOLQA_BINDING_CAPABILITY_UNSUPPORTED");
      expect(binding.objects.size).toBe(0);
    } finally {
      unbind();
    }
  });

  it("fails signed URLs explicitly when the binding issues none", async () => {
    const files = bucket({ id: "files", access: "private" });
    const app = defineApp({ name: "unsigned", resources: { files } });
    const unbind = bindApp(getAppDescriptor(app)!, createTestBinding({}, { bucket: { access: ["private"] } }));
    try {
      expect(await files.signedUrl("a", { method: "PUT", expiresInSeconds: 60 }).catch((error: { readonly code: string }) => error.code)).toBe("HOLQA_BINDING_CAPABILITY_UNSUPPORTED");
    } finally {
      unbind();
    }
  });

  it("registers object-deleted handlers and passes each event's identity to handlers", async () => {
    const images = bucket({ id: "images", access: "private" });
    const seen: unknown[] = [];
    const created = images.onObjectCreated({ id: "images.created", handler: ({ event }) => {
      seen.push(event);
    } });
    const deleted = images.onObjectDeleted({ id: "images.deleted", prefix: "raw/", handler: ({ object, event }) => {
      seen.push({ key: object.key, ...event });
    } });
    expectTypeOf(deleted).toEqualTypeOf<ObjectDeletedHandler<"images", "images.deleted">>();
    expect<unknown>(getHandlerDescriptor(deleted)?.definition).toEqual({
      id: "images.deleted",
      trigger: { kind: "bucket.object-deleted", resource: { kind: "bucket", id: "images" }, options: { prefix: "raw/" } }
    });
    const metadata = { eventId: "e-7", eventTime: "2026-10-18T10:00:00.000Z", attempt: 2 };
    await created["~holqa"].invoke({ key: "raw/a.png", size: 1 }, createContext(metadata));
    await deleted["~holqa"].invoke({ key: "raw/a.png", ignored: true }, createContext(metadata));
    expect(seen).toEqual([{ id: "e-7", time: "2026-10-18T10:00:00.000Z", attempt: 2 }, { key: "raw/a.png", id: "e-7", time: "2026-10-18T10:00:00.000Z", attempt: 2 }]);
    expect(await deleted["~holqa"].invoke({ key: "" }, createContext(metadata)).catch((error: { readonly code: string }) => error.code)).toBe("HOLQA_INPUT_INVALID");
    expect(thrownCodes(() => images.onObjectDeleted({ id: "Bad", handler: "no" } as never))).toEqual(["HOLQA_RESOURCE_ID_INVALID", "HOLQA_DECLARATION_INVALID"]);
  });

  it("types object operations and rejects malformed registrations at compile time", () => {
    const files = bucket({ id: "files", access: "private" });
    expectTypeOf(files.signedUrl).returns.toEqualTypeOf<Promise<SignedUrl>>();
    expectTypeOf(files.put).returns.toEqualTypeOf<Promise<ObjectMetadata>>();
    expectTypeOf<ObjectDeletedContext["object"]>().toEqualTypeOf<DeletedObjectInfo>();
    expectTypeOf<ObjectCreatedContext["event"]>().toEqualTypeOf<ObjectEventInfo>();
    /** Holds deliberate type errors checked by tsc; never executed. */
    const neverCalled = (): void => {
      // @ts-expect-error -- handler identifiers follow the resource identifier grammar.
      files.onObjectDeleted({ id: "Files.Deleted", handler: () => {} });
      // @ts-expect-error -- `handler` is required.
      files.onObjectDeleted({ id: "files.deleted" });
      files.onObjectDeleted({ id: "files.deleted", handler: ({ object }) => {
        // @ts-expect-error -- deleted objects have no size.
        void object.size;
      } });
      // @ts-expect-error -- signed URLs are for GET or PUT.
      void files.signedUrl("a", { method: "POST", expiresInSeconds: 60 });
      // @ts-expect-error -- `expiresInSeconds` is required.
      void files.signedUrl("a", { method: "GET" });
    };
    expect(typeof neverCalled).toBe("function");
  });
});