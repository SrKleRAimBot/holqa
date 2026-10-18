import type {
  CompileApplicationInput,
  CompileApplicationResult
} from "@/index";

import {
  application,
  bucketResource,
  configEntry,
  described,
  fixtureAdapter,
  fixtureSchema,
  httpApiResource,
  id,
  module,
  objectCreatedHandler,
  procedureHandler,
  queueConsumer,
  queueResource,
  routeHandler,
  scheduleHandler,
  scheduleResource,
  shopFixture,
  shopSchemas
} from "@test/support/application";

import { expectGolden } from "@test/support/golden";
import {
  describe,
  expect,
  it
} from "bun:test";
import {
  compileApplication,
  serializeEntrypoints,
  serializeManifest,
  validateEntrypoints,
  validateManifest
} from "@/index";

/**
 * Compiles with the fixture adapter and the Bun runtime.
 *
 * @param input - The application value and modules, plus optional overrides.
 * @returns The compilation result.
 */
async function compile(input: Partial<CompileApplicationInput> & Pick<CompileApplicationInput, "app" | "modules">): Promise<CompileApplicationResult> {
  return compileApplication({ appModule: "infra.ts", runtime: "bun", adapters: [fixtureAdapter], ...input });
}

/**
 * Compiles and returns the diagnostic codes, asserting that compilation failed.
 *
 * @param input - The application value and modules.
 * @returns The codes of every diagnostic, in output order.
 */
async function failureCodes(input: Pick<CompileApplicationInput, "app" | "modules"> & Partial<CompileApplicationInput>): Promise<string[]> {
  const result = await compile(input);
  expect(result.ok).toBe(false);
  return result.diagnostics.map(diagnostic => diagnostic.code);
}

describe("compileApplication", () => {
  it("produces the golden manifest and entry point map for the shop fixture", async () => {
    const result = await compile(shopFixture());
    if (!result.ok)
      throw new Error(JSON.stringify(result.diagnostics));
    expect(result.diagnostics).toEqual([]);
    expectGolden("shop.manifest.json", serializeManifest(result.manifest));
    expectGolden("shop.entrypoints.json", serializeEntrypoints(result.entrypoints));
  });

  it("produces output that its own readers accept", async () => {
    const result = await compile(shopFixture());
    if (!result.ok)
      throw new Error("Expected compilation to succeed.");
    const manifest = validateManifest(JSON.parse(serializeManifest(result.manifest)));
    expect(manifest.ok).toBe(true);
    if (manifest.ok)
      expect((await validateEntrypoints(JSON.parse(serializeEntrypoints(result.entrypoints)), manifest.value)).ok).toBe(true);
  });

  it("produces identical bytes across runs and declaration or discovery orders", async () => {
    const first = await compile(shopFixture());
    const second = await compile(shopFixture());
    const reversed = await compile(shopFixture({ reverse: true }));
    if (!first.ok || !second.ok || !reversed.ok)
      throw new Error("Expected compilation to succeed.");
    expect(serializeManifest(second.manifest)).toBe(serializeManifest(first.manifest));
    expect(serializeManifest(reversed.manifest)).toBe(serializeManifest(first.manifest));
    expect(serializeEntrypoints(reversed.entrypoints)).toBe(serializeEntrypoints(first.entrypoints));
  });

  it("keeps the manifest unchanged when files and exports are renamed; only the entry points move", async () => {
    const original = await compile(shopFixture());
    const renamed = await compile(shopFixture({ renamed: true }));
    if (!original.ok || !renamed.ok)
      throw new Error("Expected compilation to succeed.");
    expect(serializeManifest(renamed.manifest)).toBe(serializeManifest(original.manifest));
    expect(renamed.entrypoints.manifest).toBe(original.entrypoints.manifest);
    expect(renamed.entrypoints.handlers.find(handler => handler.id === "orders.process")).toEqual({ id: id("orders.process"), module: "src/workers/fulfil.handler.ts", export: "processOrders", exports: ["processOrders"] });
  });

  it("records no absolute path, secret value or secret default", async () => {
    const result = await compile({
      ...shopFixture(),
      modules: shopFixture().modules.map(entry => ({ ...entry, path: `./${entry.path.replaceAll("/", "\\")}` }))
    });
    if (!result.ok)
      throw new Error("Expected compilation to succeed.");
    const text = serializeManifest(result.manifest) + serializeEntrypoints(result.entrypoints);
    expect(text).not.toContain("\\\\");
    expect(text).not.toContain("./");
    expect(result.manifest.config).toEqual([
      { name: "DATABASE_URL", kind: "secret", schema: expect.objectContaining({ fingerprint: expect.stringMatching(/^sha256:/) }) },
      { name: "LOG_LEVEL", kind: "variable", schema: expect.objectContaining({ fingerprint: expect.stringMatching(/^sha256:/) }), default: "info" }
    ]);
  });

  it("derives the required capabilities from requirements and triggers", async () => {
    const result = await compile(shopFixture());
    if (!result.ok)
      throw new Error("Expected compilation to succeed.");
    expect(result.manifest.requiredCapabilities).toEqual([
      "bucket",
      "bucket.access.private",
      "http.api",
      "queue",
      "queue.dead-letter",
      "queue.delivery.at-least-once",
      "queue.max-attempts",
      "schedule",
      "schedule.overlap.skip",
      "trigger.bucket.object-created",
      "trigger.http.route",
      "trigger.queue.message",
      "trigger.schedule.tick"
    ]);
  });

  it("counts a handler exported under several names once", async () => {
    const consumer = queueConsumer("orders.process", "order-placed", shopSchemas.order);
    const result = await compile({
      app: application({ resources: [queueResource("order-placed", shopSchemas.order)] }),
      modules: [module("src/b.handler.ts", { again: consumer }), module("src/a.handler.ts", { default: consumer, named: consumer })]
    });
    if (!result.ok)
      throw new Error(JSON.stringify(result.diagnostics));
    expect(result.manifest.handlers.map(handler => handler.id)).toEqual([id("orders.process")]);
    expect(result.entrypoints.handlers).toEqual([{ id: id("orders.process"), module: "src/a.handler.ts", export: "default", exports: ["default", "named"] }]);
  });

  it("describes Holqa's own schemas, such as the SDK's object event, without an adapter", async () => {
    const event = {
      "~standard": {
        version: 1 as const,
        vendor: "holqa",
        validate: (value: unknown) => ({ value }),
        jsonSchema: { input: () => ({ type: "object", required: ["key"] }), output: () => ({ type: "object", required: ["key"], additionalProperties: false }) }
      }
    };
    const handler = objectCreatedHandler("receipts.stored", "receipts");
    const result = await compile({
      app: application({ resources: [bucketResource("receipts")] }),
      modules: [module("src/a.handler.ts", { default: described({ ...handler["~holqa"], schemas: { object: event } }) })],
      adapters: []
    });
    if (!result.ok)
      throw new Error(JSON.stringify(result.diagnostics));
    const { object } = result.manifest.handlers[0]!.schemas;
    expect(object?.source).toEqual({ vendor: "holqa", library: "holqa", fidelity: "verified" });
    expect(result.diagnostics).toEqual([]);
  });

  it("rejects a default export that is not an application", async () => {
    expect(await failureCodes({ app: { name: "shop" }, modules: [] })).toEqual(["HOLQA_APP_INVALID"]);
    expect(await failureCodes({ app: described({ protocol: 2, type: "app" }), modules: [] })).toEqual(["HOLQA_APP_INVALID"]);
  });

  it("rejects a handler whose resource is not declared, and names the candidates", async () => {
    const result = await compile({
      app: application({ resources: [queueResource("order-placed", shopSchemas.order)] }),
      modules: [module("src/refund.handler.ts", { default: queueConsumer("refunds.process", "refunds", shopSchemas.order) })],
      sources: { "src/refund.handler.ts": "export default resources.refunds.consume({\n  id: \"refunds.process\",\n});" }
    });
    expect(result.ok).toBe(false);
    expect(result.diagnostics).toEqual([expect.objectContaining({
      code: "HOLQA_RESOURCE_NOT_FOUND",
      severity: "error",
      location: { file: "src/refund.handler.ts", line: 2, column: 7 },
      hint: expect.stringContaining("\"order-placed\""),
      details: { handler: "refunds.process", resource: "refunds", kind: "queue" }
    })]);
  });

  it("rejects two different registrations with one handler identifier", async () => {
    const result = await compile({
      app: application({ resources: [queueResource("order-placed", shopSchemas.order), bucketResource("receipts")] }),
      modules: [
        module("src/a.handler.ts", { default: queueConsumer("orders.process", "order-placed", shopSchemas.order) }),
        module("src/b.handler.ts", { default: objectCreatedHandler("orders.process", "receipts") })
      ]
    });
    expect(result.diagnostics.map(diagnostic => [diagnostic.code, diagnostic.location?.file])).toEqual([["HOLQA_HANDLER_ID_DUPLICATE", "src/b.handler.ts"]]);
    expect(result.diagnostics[0]?.details).toEqual({ id: "orders.process", modules: ["src/a.handler.ts", "src/b.handler.ts"] });
  });

  it("rejects duplicate resource identifiers", async () => {
    const codes = await failureCodes({ app: application({ resources: [bucketResource("files"), bucketResource("files", "public-read")] }), modules: [] });
    expect(codes).toEqual(["HOLQA_RESOURCE_ID_DUPLICATE"]);
  });

  it("rejects a trigger whose resource has another kind", async () => {
    const codes = await failureCodes({
      app: application({ resources: [bucketResource("order-placed")] }),
      modules: [module("src/a.handler.ts", { default: queueConsumer("orders.process", "order-placed", shopSchemas.order) })]
    });
    expect(codes).toEqual(["HOLQA_TRIGGER_INVALID"]);
  });

  it("rejects a consumer whose message contract differs from its queue's", async () => {
    const codes = await failureCodes({
      app: application({ resources: [queueResource("order-placed", shopSchemas.order)] }),
      modules: [module("src/a.handler.ts", { default: queueConsumer("orders.process", "order-placed", fixtureSchema({ type: "string" })) })]
    });
    expect(codes).toEqual(["HOLQA_TRIGGER_INVALID"]);
  });

  it("rejects malformed trigger options and schema roles", async () => {
    const consumer = queueConsumer("orders.process", "order-placed", shopSchemas.order, 0);
    const codes = await failureCodes({
      app: application({ resources: [queueResource("order-placed", shopSchemas.order)] }),
      modules: [module("src/a.handler.ts", { default: consumer })]
    });
    expect(codes).toEqual(["HOLQA_TRIGGER_INVALID"]);

    const route = routeHandler("orders.get", "shop-api", "GET", "orders/:id/");
    expect(await failureCodes({ app: application({ resources: [httpApiResource("shop-api")] }), modules: [module("src/a.handler.ts", { default: route })] })).toEqual(["HOLQA_TRIGGER_INVALID"]);
  });

  it("rejects a second consumer of one queue", async () => {
    const result = await compile({
      app: application({ resources: [queueResource("order-placed", shopSchemas.order)] }),
      modules: [
        module("src/a.handler.ts", { default: queueConsumer("orders.process", "order-placed", shopSchemas.order) }),
        module("src/b.handler.ts", { default: queueConsumer("orders.audit", "order-placed", shopSchemas.order) })
      ]
    });
    expect(result.diagnostics.map(diagnostic => diagnostic.code)).toEqual(["HOLQA_QUEUE_CONSUMER_DUPLICATE"]);
    expect(result.diagnostics[0]?.details).toEqual({ queue: "order-placed", handlers: ["orders.audit", "orders.process"] });
  });

  it("rejects routes that match the same requests, ignoring parameter names", async () => {
    const result = await compile({
      app: application({ resources: [httpApiResource("shop-api")] }),
      modules: [module("src/a.handler.ts", {
        byId: routeHandler("orders.get", "shop-api", "GET", "/orders/:orderId"),
        byKey: routeHandler("orders.by-key", "shop-api", "GET", "/orders/:key"),
        create: routeHandler("orders.create", "shop-api", "POST", "/orders/:orderId"),
        fresh: routeHandler("orders.new", "shop-api", "GET", "/orders/new")
      })]
    });
    expect(result.diagnostics.map(diagnostic => diagnostic.code)).toEqual(["HOLQA_ROUTE_CONFLICT"]);
    expect(result.diagnostics[0]?.details).toEqual({ route: "GET /api/orders/:", handlers: ["orders.by-key", "orders.get"] });
  });

  it("rejects routes of different APIs that share a base path and serve the same requests, as the runtime does", async () => {
    const result = await compile({
      app: application({ resources: [httpApiResource("public-api"), httpApiResource("admin-api")] }),
      modules: [module("src/a.handler.ts", { a: routeHandler("public.orders", "public-api", "GET", "/orders"), b: routeHandler("admin.orders", "admin-api", "GET", "/orders") })]
    });
    expect(result.diagnostics.map(diagnostic => [diagnostic.code, diagnostic.details])).toEqual([["HOLQA_ROUTE_CONFLICT", { route: "GET /api/orders", handlers: ["admin.orders", "public.orders"] }]]);
  });

  it("records procedures with their operation and input and output schemas", async () => {
    const output = fixtureSchema({ type: "object", properties: { total: { type: "integer" } }, required: ["total"] });
    const input = fixtureSchema({ type: "object", properties: { orderId: { type: "string" } }, required: ["orderId"] });
    const result = await compile({
      app: application({ resources: [httpApiResource("shop-api")] }),
      modules: [module("src/a.handler.ts", { default: procedureHandler("orders.total", "shop-api", "query", output, input) })]
    });
    expect(result.ok).toBe(true);
    if (!result.ok)
      return;
    expect<unknown>(result.manifest.handlers.map(handler => [handler.trigger, Object.keys(handler.schemas)])).toEqual([
      [{ kind: "http.procedure", resource: { kind: "http.api", id: "shop-api" }, options: { operation: "query" } }, ["input", "output"]]
    ]);
    expect(result.manifest.requiredCapabilities).toContain("trigger.http.procedure");
    expect(validateManifest(JSON.parse(serializeManifest(result.manifest))).ok).toBe(true);
  });

  it("records a route's headers schema in a manifest the JSON Schema accepts", async () => {
    const route = routeHandler("orders.list", "shop-api", "GET", "/orders", { 200: fixtureSchema({ type: "string" }) });
    const withHeaders = { "~holqa": { ...route["~holqa"], schemas: { ...route["~holqa"].schemas, headers: fixtureSchema({ type: "object" }) } } };
    const result = await compile({ app: application({ resources: [httpApiResource("shop-api")] }), modules: [module("src/a.handler.ts", { default: withHeaders })] });
    expect(result.ok).toBe(true);
    if (!result.ok)
      return;
    expect(Object.keys(result.manifest.handlers[0]!.schemas)).toEqual(["headers", "response.200"]);
    expect(validateManifest(JSON.parse(serializeManifest(result.manifest))).ok).toBe(true);
  });

  it("rejects routes that collide with a procedure's RPC path", async () => {
    const output = fixtureSchema({ type: "string" });
    const result = await compile({
      app: application({ resources: [httpApiResource("shop-api")] }),
      modules: [module("src/a.handler.ts", {
        query: procedureHandler("orders.total", "shop-api", "query", output),
        mutation: procedureHandler("orders.cancel", "shop-api", "mutation", output),
        shadowsQuery: routeHandler("rpc.get", "shop-api", "GET", "/rpc/orders.total"),
        // A parameter segment never conflicts with a static one: routers prefer the static procedure path.
        parameter: routeHandler("rpc.any", "shop-api", "POST", "/rpc/:name"),
        unrelated: routeHandler("rpc.put", "shop-api", "PUT", "/rpc/orders.cancel")
      })]
    });
    expect(result.diagnostics.map(diagnostic => diagnostic.code)).toEqual(["HOLQA_ROUTE_CONFLICT"]);
    expect(result.diagnostics[0]?.details).toEqual({ route: "GET /api/rpc/orders.total", handlers: ["orders.total", "rpc.get"] });
  });

  it("rejects a procedure without an output schema or with an unknown operation", async () => {
    const output = fixtureSchema({ type: "string" });
    const missingOutput = procedureHandler("orders.total", "shop-api", "query", output);
    const withoutOutput = { "~holqa": { ...missingOutput["~holqa"], schemas: {} } };
    const badOperation = procedureHandler("orders.cancel", "shop-api", "subscription" as "query", output);
    const codes = await failureCodes({ app: application({ resources: [httpApiResource("shop-api")] }), modules: [module("src/a.handler.ts", { withoutOutput, badOperation })] });
    expect(codes).toEqual(["HOLQA_TRIGGER_INVALID", "HOLQA_TRIGGER_INVALID"]);
  });

  it("rejects unknown resource settings instead of dropping them", async () => {
    const queue = queueResource("order-placed", shopSchemas.order);
    const withProviderBag = { ...queue, config: { ...queue.config, providerOptions: { region: "x" } } } as typeof queue;
    const result = await compile({ app: application({ resources: [withProviderBag] }), modules: [] });
    expect(result.diagnostics.map(diagnostic => [diagnostic.code, diagnostic.message])).toEqual([
      ["HOLQA_DECLARATION_INVALID", "The queue \"order-placed\": \"config.providerOptions\" is not a recognized setting."]
    ]);
  });

  it("rejects a secret with a default without recording the value", async () => {
    const result = await compile({ app: application({ resources: [], config: [configEntry("API_TOKEN", shopSchemas.databaseUrl, { sensitive: true, defaultValue: "s3cr3t-value" })] }), modules: [] });
    expect(result.diagnostics.map(diagnostic => diagnostic.code)).toEqual(["HOLQA_DECLARATION_INVALID"]);
    expect(JSON.stringify(result)).not.toContain("s3cr3t-value");
  });

  it("rejects a schema without a portable wire form", async () => {
    const opaque = { "~standard": { version: 1 as const, vendor: "opaque", validate: (value: unknown) => ({ value }) } };
    const codes = await failureCodes({ app: application({ resources: [queueResource("order-placed", opaque)] }), modules: [] });
    expect(codes).toEqual(["HOLQA_SCHEMA_UNSUPPORTED"]);
  });

  it("rejects a response schema whose output cannot be described", async () => {
    const response = fixtureSchema({ type: "string" }, "a Date has no JSON form");
    const codes = await failureCodes({
      app: application({ resources: [httpApiResource("shop-api")] }),
      modules: [module("src/a.handler.ts", { default: routeHandler("orders.get", "shop-api", "GET", "/orders/:id", { 200: response }) })]
    });
    expect(codes).toEqual(["HOLQA_SCHEMA_UNSUPPORTED"]);
  });

  it("accepts an unrepresentable output on an input-side role", async () => {
    const message = fixtureSchema({ type: "string" }, "a Date has no JSON form");
    const result = await compile({ app: application({ resources: [queueResource("order-placed", message)] }), modules: [] });
    expect(result.ok).toBe(true);
  });

  it("rejects exports with an unreadable descriptor and module paths outside the root", async () => {
    const codes = await failureCodes({
      app: application({ resources: [] }),
      modules: [module("src/a.handler.ts", { default: described({ protocol: 99, type: "handler" }) }), module("/abs/b.handler.ts", {})]
    });
    expect(codes).toEqual(["HOLQA_DECLARATION_INVALID", "HOLQA_DECLARATION_INVALID"]);
  });

  it("ignores re-exported applications and resources in handler modules", async () => {
    const app = application({ resources: [scheduleResource("nightly")] });
    const result = await compile({ app, modules: [module("src/a.handler.ts", { app, default: scheduleHandler("nightly.run", "nightly") })] });
    expect(result.ok).toBe(true);
  });

  it("reports every problem at once, sorted by location", async () => {
    const result = await compile({
      app: application({ resources: [queueResource("order-placed", shopSchemas.order)] }),
      modules: [
        module("src/b.handler.ts", { default: scheduleHandler("reports.nightly", "nightly") }),
        module("src/a.handler.ts", { default: objectCreatedHandler("receipts.stored", "receipts") })
      ]
    });
    expect(result.diagnostics.map(diagnostic => [diagnostic.code, diagnostic.location?.file])).toEqual([
      ["HOLQA_RESOURCE_NOT_FOUND", "src/a.handler.ts"],
      ["HOLQA_RESOURCE_NOT_FOUND", "src/b.handler.ts"]
    ]);
  });

  it("rejects handler patterns that escape the application", async () => {
    expect(await failureCodes({ app: application({ resources: [], include: ["../shared/*.ts", ""] }), modules: [] })).toEqual(["HOLQA_DECLARATION_INVALID", "HOLQA_DECLARATION_INVALID"]);
  });

  it("rejects host inputs that would make output machine-dependent", async () => {
    expect(await failureCodes({ ...shopFixture(), appModule: "/home/user/app/infra.ts" })).toEqual(["HOLQA_DECLARATION_INVALID"]);
  });
});