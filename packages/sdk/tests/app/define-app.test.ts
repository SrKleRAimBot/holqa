import type {
  App,
  BucketHandle,
  QueueHandle
} from "@/index";

import {
  bindApp,
  getAppDescriptor,
  HolqaError
} from "@holqa/core";
import {
  createTestBinding,
  thrownCodes
} from "@test/support/test-binding";
import {
  describe,
  expect,
  expectTypeOf,
  it
} from "bun:test";
import { z } from "zod";

import {
  bucket,
  defineApp,
  queue,
  secret,
  variable
} from "@/index";

/** The message schema shared by the queues in these tests. */
const job = z.object({ n: z.number() });

/**
 * Builds a small application from fresh resource handles.
 *
 * @returns The application.
 */
function buildApp() {
  return defineApp({
    name: "demo",
    handlers: { include: ["./src/**/*.handler.ts"], exclude: ["./src/**/*.test.ts"] },
    resources: {
      jobs: queue({ id: "jobs", message: job, schemaVersion: 1 }),
      files: bucket({ id: "files", access: "private" })
    },
    env: { TOKEN: secret(z.string()), MODE: variable(z.enum(["a", "b"]), { default: "a" }) }
  });
}

describe("defineApp", () => {
  it("preserves the exact types of the supplied resources", () => {
    const app = buildApp();
    expectTypeOf(app).toEqualTypeOf<App<{
      readonly jobs: QueueHandle<"jobs", typeof job>;
      readonly files: BucketHandle<"files">;
    }, {
      readonly TOKEN: ReturnType<typeof secret<z.ZodString>>;
      readonly MODE: ReturnType<typeof variable<z.ZodEnum<{ a: "a"; b: "b" }>>>;
    }>>();
    expectTypeOf(app.env).toEqualTypeOf<{ readonly TOKEN: string; readonly MODE: "a" | "b" }>();
    expect(app.resources.jobs.id).toBe("jobs");
  });

  it("is pure: two calls produce equivalent descriptors and nothing is bound", () => {
    const first = getAppDescriptor(buildApp())!;
    const second = getAppDescriptor(buildApp())!;
    /**
     * Keeps the JSON parts of a descriptor; schemas are separate objects per call.
     *
     * @param descriptor - An application descriptor.
     * @returns Its name, handler patterns, resource data and configuration data.
     */
    const data = (descriptor: typeof first): unknown => ({
      name: descriptor.name,
      handlers: descriptor.handlers,
      resources: descriptor.resources.map(({ kind, id, config, requirements }) => ({ kind, id, config, requirements })),
      config: descriptor.config.map(({ name, sensitive, defaultValue }) => ({ name, sensitive, defaultValue }))
    });
    expect(data(first)).toEqual(data(second));
    expect(first.binding.current).toBeUndefined();
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.resources[0]!.requirements)).toBe(true);
    expect(first.handlers).toEqual({ include: ["./src/**/*.handler.ts"], exclude: ["./src/**/*.test.ts"] });
  });

  it("defaults to no handlers and no configuration", () => {
    const app = defineApp({ name: "bare", resources: {} });
    expectTypeOf(app.env).toEqualTypeOf<{}>();
    expect(getAppDescriptor(app)?.handlers).toEqual({ include: [], exclude: [] });
    expect(getAppDescriptor(app)?.config).toEqual([]);
  });

  it("fails clearly when handles or configuration are used without a runtime", async () => {
    const app = buildApp();
    expect(thrownCodes(() => app.env.TOKEN)).toEqual(["HOLQA_RUNTIME_NOT_BOUND"]);
    const error = await app.resources.jobs.send({ n: 1 }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(HolqaError);
    expect((error as HolqaError).code).toBe("HOLQA_RUNTIME_NOT_BOUND");
  });

  it("reads configuration and sends messages through the bound runtime", async () => {
    const app = buildApp();
    const binding = createTestBinding({ TOKEN: "t" });
    const unbind = bindApp(getAppDescriptor(app)!, binding);
    expect(app.env.TOKEN).toBe("t");
    expect(app.env.MODE).toBe("a");
    await app.resources.jobs.send({ n: 2 });
    expect(binding.sent.map(({ queue, message }) => ({ queue, message }))).toEqual([{ queue: "jobs", message: { n: 2 } }]);
    unbind();
    expect(thrownCodes(() => app.env.MODE)).toEqual(["HOLQA_RUNTIME_NOT_BOUND"]);
  });

  it("rejects duplicate resource identifiers, listing every alias", () => {
    const ids: string[] = ["same", "same"];
    let error: unknown;
    try {
      defineApp({
        name: "dup",
        resources: {
          a: bucket({ id: ids[0]!, access: "private" }),
          b: bucket({ id: ids[1]!, access: "private" })
        }
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(HolqaError);
    expect((error as HolqaError).diagnostics.map(diagnostic => diagnostic.code)).toEqual(["HOLQA_RESOURCE_ID_DUPLICATE"]);
    expect((error as HolqaError).message).toContain("resources.a, resources.b");
  });

  it("rejects duplicate literal identifiers at compile time", () => {
    /** Holds deliberate type errors checked by tsc; never executed. */
    const neverCalled = (): void => {
      // @ts-expect-error -- "same" is declared twice; the error names the identifier.
      defineApp({
        name: "dup",
        resources: {
          a: bucket({ id: "same", access: "private" }),
          b: queue({ id: "same", message: job, schemaVersion: 1 })
        }
      });
      const shared = bucket({ id: "shared", access: "private" });
      // @ts-expect-error -- the same handle under two aliases duplicates its identifier.
      defineApp({ name: "twice", resources: { first: shared, second: shared } });
    };
    expect(typeof neverCalled).toBe("function");
  });

  it("reports every problem in a malformed definition at once", () => {
    const codes = thrownCodes(() => defineApp({
      name: "Not Valid" as string,
      handlers: ["/abs/*.ts", "../outside/*.ts", ""],
      resources: { notAResource: { kind: "queue", id: "x" } as never },
      env: { "bad-name": secret(z.string()), "MISSING": "nope" as never }
    }));
    expect(codes).toEqual([
      "HOLQA_RESOURCE_ID_INVALID",
      "HOLQA_DECLARATION_INVALID",
      "HOLQA_DECLARATION_INVALID",
      "HOLQA_DECLARATION_INVALID",
      "HOLQA_DECLARATION_INVALID",
      "HOLQA_DECLARATION_INVALID",
      "HOLQA_DECLARATION_INVALID"
    ]);
  });

  it("rejects missing required properties at compile time and at run time", () => {
    /** Holds deliberate type errors checked by tsc; never executed. */
    const neverCalled = (): void => {
      // @ts-expect-error -- `name` is required.
      defineApp({ resources: {} });
      // @ts-expect-error -- the application name follows the identifier grammar.
      defineApp({ name: "Not Valid", resources: {} });
      // @ts-expect-error -- `resources` is required.
      defineApp({ name: "empty" });
      // @ts-expect-error -- resources must be resource handles.
      defineApp({ name: "wrong", resources: { orders: { id: "orders" } } });
      // @ts-expect-error -- env entries must be secret(...) or variable(...).
      defineApp({ name: "wrong", resources: {}, env: { TOKEN: z.string() } });
    };
    expect(typeof neverCalled).toBe("function");
    expect(thrownCodes(() => defineApp({ name: "empty" } as never))).toEqual(["HOLQA_DECLARATION_INVALID"]);
    expect(thrownCodes(() => defineApp(undefined as never))).toEqual(["HOLQA_DECLARATION_INVALID"]);
  });

  it("does not let one resource handle belong to two applications", () => {
    const shared = queue({ id: "shared", message: z.string(), schemaVersion: 1 });
    defineApp({ name: "one", resources: { shared } });
    expect(thrownCodes(() => defineApp({ name: "two", resources: { shared } }))).toEqual(["HOLQA_DECLARATION_INVALID"]);
  });

  it("rejects handles that were never passed to defineApp when they are used", async () => {
    const orphan = queue({ id: "orphan", message: z.string(), schemaVersion: 1 });
    const error = await orphan.send("x").catch((caught: unknown) => caught);
    expect((error as HolqaError).code).toBe("HOLQA_DECLARATION_INVALID");
  });

  it("explains descriptors from an unsupported protocol version or kind", () => {
    let message = "";
    try {
      defineApp({ name: "future", resources: { topic: { "kind": "topic", "id": "events", "~holqa": { protocol: 1, type: "resource", kind: "topic", id: "events" } } as never } });
    } catch (error) {
      message = (error as HolqaError).message;
    }
    expect(message).toContain("does not support");
  });

  it("leaves handles unclaimed when the definition is rejected", () => {
    const orders = queue({ id: "orders", message: z.string(), schemaVersion: 1 });
    expect(thrownCodes(() => defineApp({ name: "Bad Name" as string, resources: { orders } }))).toEqual(["HOLQA_RESOURCE_ID_INVALID"]);
    expect(thrownCodes(() => defineApp({ name: "good", resources: { orders } }))).toEqual([]);
  });
});