import type {
  CompileResult,
  EvaluatedModule
} from "@/compile";

import { diagnosticCodes } from "@holqa/core";
import { experimentCodes } from "@holqa/experiment-model";
import { zodAdapter } from "@holqa/experiment-schema-adapters";
import {
  bucket,
  defineApp,
  http,
  queue,
  schedule,
  secret,
  variable
} from "@holqa/experiment-sdk";
import {
  describe,
  expect,
  it
} from "bun:test";
import { z } from "zod";

import { compileApp } from "@/compile";
import { serializeManifest } from "@/serialize";

/**
 * Declares a small application with fresh resource handles (a handle can
 * belong to only one application).
 *
 * @param options - Variations used by individual tests.
 * @param options.queueId - The queue's identifier.
 * @param options.duplicateQueue - Declares a second queue reusing the identifier.
 * @param options.reversed - Declares resources in reverse order.
 * @returns The application and its handles.
 */
function createApp(options: { readonly queueId?: string; readonly duplicateQueue?: boolean; readonly reversed?: boolean } = {}) {
  const api = http.api({ id: "public-api", basePath: "/api" });
  const orders = queue({ id: options.queueId ?? "order-processing", message: z.object({ orderId: z.string(), priority: z.enum(["normal", "urgent"]) }), schemaVersion: 1 });
  const uploads = bucket({ id: "uploads", access: "private" });
  const cleanup = schedule({ id: "daily-cleanup", cron: "0 2 * * *", timezone: "UTC", overlap: "skip" });
  const entries = [["api", api], ["orders", orders], ["uploads", uploads], ["cleanup", cleanup]] as const;
  const resources = Object.fromEntries(options.reversed === true ? [...entries].reverse() : entries) as { api: typeof api; orders: typeof orders; uploads: typeof uploads; cleanup: typeof cleanup };
  const app = defineApp({
    name: "unit",
    handlers: ["./src/**/*.handler.ts"],
    resources: options.duplicateQueue === true
      ? { ...resources, again: queue({ id: orders.id, message: z.object({ id: z.string() }), schemaVersion: 1 }) }
      : resources,
    env: {
      DATABASE_URL: secret(z.string().min(1)),
      LOG_LEVEL: variable(z.enum(["info", "debug"]), { default: "info" })
    }
  });
  return { app, api, orders, uploads, cleanup };
}

/**
 * Builds the standard set of handler modules for an application.
 *
 * @param handles - The application's handles.
 * @returns Evaluated modules as a host would supply them.
 */
function standardModules(handles: ReturnType<typeof createApp>): EvaluatedModule[] {
  const create = handles.api.route({
    id: "orders.create",
    method: "POST",
    path: "/orders",
    body: z.object({ sku: z.string() }),
    responses: { 202: z.object({ orderId: z.string() }) },
    handler: ({ reply }) => reply(202, { orderId: "o" })
  });
  return [
    { path: "src/orders/create.handler.ts", exports: { default: create, create } },
    { path: "src/orders/process.handler.ts", exports: { default: handles.orders.consume({ id: "orders.process", handler: () => {} }), notAHandler: 42 } },
    { path: "src/uploads/on-upload.handler.ts", exports: { default: handles.uploads.onObjectCreated({ id: "uploads.received", prefix: "in/", handler: () => {} }) } },
    { path: "src/cleanup.handler.ts", exports: { default: handles.cleanup.handle({ id: "maintenance.cleanup", handler: () => {} }) } }
  ];
}

/**
 * Lists the codes of a result's error diagnostics.
 *
 * @param result - A compile result.
 * @returns Error codes in diagnostic order.
 */
function errorCodes(result: CompileResult): string[] {
  return result.diagnostics.filter(diagnostic => diagnostic.severity === "error").map(diagnostic => diagnostic.code);
}

describe("compileApp", () => {
  it("compiles a valid application into a sorted, portable manifest", async () => {
    const handles = createApp();
    const result = await compileApp({ app: handles.app, modules: standardModules(handles), adapters: [zodAdapter] });
    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
    const manifest = result.manifest!;
    expect(manifest.manifestVersion).toBe(0);
    expect(manifest.resources.map(resource => resource.id)).toEqual(["daily-cleanup", "order-processing", "public-api", "uploads"]);
    expect(manifest.handlers.map(handler => handler.id)).toEqual(["maintenance.cleanup", "orders.create", "orders.process", "uploads.received"]);
    expect(manifest.handlers.find(handler => handler.id === "orders.create")?.exports).toEqual(["create", "default"]);
    for (const use of Object.values(manifest.resources.find(resource => resource.id === "order-processing")!.schemas))
      expect(manifest.schemas[use.input!]).toBeDefined();
  });

  it("does not depend on module order, export order or resource declaration order", async () => {
    const first = createApp();
    const second = createApp({ reversed: true });
    const forward = await compileApp({ app: first.app, modules: standardModules(first), adapters: [zodAdapter] });
    const backward = await compileApp({ app: second.app, modules: standardModules(second).reverse(), adapters: [zodAdapter] });
    expect(serializeManifest(backward.manifest!)).toBe(serializeManifest(forward.manifest!));
  });

  it("records secrets by name and schema only, and keeps variable defaults", async () => {
    const handles = createApp();
    const { manifest } = await compileApp({ app: handles.app, modules: [], adapters: [zodAdapter] });
    expect(manifest!.configuration.map(entry => Object.keys(entry).sort())).toEqual([["name", "schema", "sensitive"], ["default", "name", "schema", "sensitive"]]);
  });

  it("collects every problem instead of stopping at the first", async () => {
    const handles = createApp({ queueId: "Orders", duplicateQueue: true });
    const modules: EvaluatedModule[] = [
      ...standardModules(handles),
      { path: "src/orders/second.handler.ts", exports: { default: handles.orders.consume({ id: "orders.second", handler: () => {} }) } },
      { path: "src/orders/dupe.handler.ts", exports: { default: handles.uploads.onObjectCreated({ id: "orders.process", handler: () => {} }) } },
      { path: "src/orders/get.handler.ts", exports: {
        a: handles.api.route({ id: "orders.by-id", method: "GET", path: "/orders/:id", responses: { 200: z.object({}) }, handler: ({ reply }) => reply(200, {}) }),
        b: handles.api.route({ id: "orders.by-order-id", method: "GET", path: "orders/:orderId/", responses: { 200: z.object({}) }, handler: ({ reply }) => reply(200, {}) }),
        c: handles.api.route({ id: "orders.new", method: "GET", path: "/orders/new", responses: { 200: z.object({}) }, handler: ({ reply }) => reply(200, {}) })
      } },
      { path: "src/Bad_Handler.ts", exports: { default: handles.cleanup.handle({ id: "Bad_Id", handler: () => {} }) } }
    ];
    const result = await compileApp({ app: handles.app, modules, adapters: [zodAdapter] });
    expect(result.ok).toBe(false);
    expect(new Set(errorCodes(result))).toEqual(new Set([
      diagnosticCodes.resourceIdInvalid,
      experimentCodes.resourceIdDuplicate,
      experimentCodes.handlerIdDuplicate,
      experimentCodes.queueConsumerDuplicate,
      experimentCodes.routeAmbiguous
    ]));
    const ambiguous = result.diagnostics.find(diagnostic => diagnostic.code === experimentCodes.routeAmbiguous)!;
    expect(ambiguous.message).toContain("orders.by-id");
    expect(ambiguous.message).not.toContain("orders.new");
  });

  it("reports handlers whose resource is missing or has the wrong kind", async () => {
    const handles = createApp();
    const orphan = queue({ id: "not-declared", message: z.object({}), schemaVersion: 1 });
    const result = await compileApp({
      app: handles.app,
      adapters: [zodAdapter],
      modules: [
        { path: "src/orphan.handler.ts", exports: { default: orphan.consume({ id: "orphan.consume", handler: () => {} }) } },
        { path: "src/wrong.handler.ts", exports: { default: { ...handles.orders.consume({ id: "wrong.kind", handler: () => {} }), "~holqa": { ...handles.orders.consume({ id: "wrong.kind", handler: () => {} })["~holqa"], trigger: { kind: "queue.message", resource: "uploads" } } } } }
      ]
    });
    expect(errorCodes(result)).toEqual([experimentCodes.resourceNotFound, experimentCodes.declarationInvalid]);
  });

  it("rejects absolute and escaping module paths, and normalizes separators", async () => {
    const handles = createApp();
    const handler = handles.cleanup.handle({ id: "maintenance.cleanup", handler: () => {} });
    const result = await compileApp({
      app: handles.app,
      adapters: [zodAdapter],
      modules: [
        { path: "/home/dev/app/src/a.handler.ts", exports: { default: handler } },
        { path: "C:\\app\\src\\b.handler.ts", exports: { default: handler } },
        { path: "../outside.handler.ts", exports: { default: handler } },
        { path: ".\\src\\cleanup.handler.ts", exports: { default: handler } }
      ]
    });
    expect(errorCodes(result)).toEqual([experimentCodes.declarationInvalid, experimentCodes.declarationInvalid, experimentCodes.declarationInvalid]);
    expect(result.manifest!.handlers.map(entry => entry.module)).toEqual(["src/cleanup.handler.ts"]);
  });

  it("fails on exports with an unknown descriptor protocol instead of dropping them", async () => {
    const handles = createApp();
    /** A function-valued export carrying a future descriptor version. */
    const futureFunction = Object.assign(() => undefined, { "~holqa": { protocol: 2, type: "handler" } });
    const result = await compileApp({ app: handles.app, adapters: [zodAdapter], modules: [{ path: "src/future.handler.ts", exports: { default: { "~holqa": { protocol: 2, type: "handler" } }, futureFunction } }] });
    expect(result.diagnostics.map(diagnostic => [diagnostic.code, diagnostic.severity])).toEqual([[experimentCodes.declarationInvalid, "error"], [experimentCodes.declarationInvalid, "error"]]);
  });

  it("fails on trigger kinds the compiler does not support", async () => {
    const handles = createApp();
    const { "~holqa": declared } = handles.app;
    const resource = declared.resources[0]!;
    const unknownTrigger = { "~holqa": { protocol: 1, type: "handler", id: "future.handler", trigger: { kind: "topic.message", resource: resource.id }, config: {}, schemas: {}, invoke: async () => undefined } };
    const result = await compileApp({ app: handles.app, adapters: [zodAdapter], modules: [{ path: "src/future.handler.ts", exports: { unknownTrigger } }] });
    expect(result.diagnostics.filter(diagnostic => diagnostic.severity === "error").map(diagnostic => diagnostic.code)).toEqual([experimentCodes.declarationInvalid]);
  });

  it("fails without a manifest when the application export is not an application", async () => {
    const result = await compileApp({ app: { name: "nope" }, modules: [], adapters: [] });
    expect(result.manifest).toBeUndefined();
    expect(errorCodes(result)).toEqual([experimentCodes.declarationInvalid]);
  });

  it("reports schemas no adapter or converter can represent", async () => {
    const api = http.api({ id: "public-api", basePath: "/" });
    const app = defineApp({ name: "dates", handlers: [], resources: { api } });
    const route = api.route({ id: "events.create", method: "POST", path: "/events", body: z.object({ at: z.date() }), responses: { 204: z.null() }, handler: ({ reply }) => reply(204, null) });
    const result = await compileApp({ app, adapters: [zodAdapter], modules: [{ path: "src/events.handler.ts", exports: { route } }] });
    expect(errorCodes(result)).toContain(experimentCodes.schemaUnsupported);
    const { body } = result.manifest!.handlers[0]!.schemas;
    expect(body!.input).toBeNull();
  });
});