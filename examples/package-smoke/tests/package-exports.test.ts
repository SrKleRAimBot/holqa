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
  mkdtempSync,
  rmSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalJsonStringify,
  checkSchemaCompatibility,
  compileApplication,
  describeSchemaContract,
  validateManifest
} from "@holqa/compiler";
import {
  createMessageCodec,
  getAppDescriptor,
  parseResourceId
} from "@holqa/core";
import {
  createLocalEnvironment,
  ManualClock
} from "@holqa/local";
import {
  createRuntime,
  silentSink
} from "@holqa/runtime-bun";
import {
  defineApp,
  http,
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

  it("compiles an SDK application into a manifest its reader accepts", async () => {
    const app = defineApp({ name: "smoke", resources: { orders: queue({ id: "orders", message: z.object({ id: z.string() }), schemaVersion: 1 }) } });
    const consumer = app.resources.orders.consume({ id: "orders.process", handler: () => {} });
    const result = await compileApplication({ app, appModule: "infra.ts", modules: [{ path: "src/orders.ts", exports: { default: consumer } }], runtime: "bun", adapters: [zodAdapter] });
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(validateManifest(JSON.parse(canonicalJsonStringify(result.manifest))).ok).toBe(true);
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

describe("@holqa/runtime-bun public exports", () => {
  it("serves an SDK route and procedure through the built runtime", async () => {
    const api = http.api({ id: "smoke-api", basePath: "/api" });
    const app = defineApp({ name: "runtime-smoke", resources: { api } });
    const route = app.resources.api.route({ id: "hello", method: "GET", path: "/hello/:name", responses: { 200: z.object({ hello: z.string() }) }, handler: ({ params, reply }) => reply(200, { hello: params.name }) });
    const procedure = app.resources.api.procedure({ id: "ping", operation: "query", output: z.literal("pong"), handler: () => "pong" as const });
    const runtime = createRuntime({ app, handlers: [route, procedure], env: {}, log: silentSink });
    await runtime.start();
    expect(await (await runtime.fetch(new Request("http://localhost/api/hello/ada"))).json()).toEqual({ hello: "ada" });
    expect(await (await runtime.fetch(new Request("http://localhost/api/rpc/ping"))).json()).toEqual({ format: "holqa.rpc/1", ok: true, output: "pong" });
    expect((await runtime.fetch(new Request("http://localhost/api/hello"))).status).toBe(404);
    await runtime.stop();
  });
});

describe("@holqa/local public exports", () => {
  it("delivers an SDK queue message through the built local binding", async () => {
    const jobs = queue({ id: "smoke-jobs", message: z.object({ n: z.number() }), schemaVersion: 1 });
    const app = defineApp({ name: "local-smoke", resources: { jobs } });
    const seen: number[] = [];
    const consumer = app.resources.jobs.consume({ id: "smoke-jobs.run", handler: ({ message }) => {
      seen.push(message.n);
    } });
    const directory = mkdtempSync(join(tmpdir(), "holqa-smoke-local-"));
    const env = await createLocalEnvironment({ app, directory, clock: new ManualClock(), env: {} });
    const runtime = createRuntime({ app, handlers: [consumer], binding: env.binding, log: silentSink });
    try {
      await runtime.start();
      expect(await app.resources.jobs.send({ n: 7 })).toEqual({ messageId: expect.any(String) });
      await env.settle();
      expect(seen).toEqual([7]);
    } finally {
      await runtime.stop();
      env.close();
      rmSync(directory, { recursive: true, force: true });
    }
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