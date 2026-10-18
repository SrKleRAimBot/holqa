import type {
  AppDescriptor,
  ConfigDescriptor,
  Described,
  HandlerDescriptor,
  HttpMethod,
  JsonObject,
  JsonValue,
  ResourceDescriptor,
  ResourceId,
  SchemaAdapter,
  StandardSchemaV1
} from "@holqa/core";

import type { EvaluatedModule } from "@/index";

import {
  createBindingSlot,
  err,
  ok,
  parseResourceId
} from "@holqa/core";

// Builders for descriptors written as plain object literals, the way any SDK
// (or a second copy of @holqa/core) would write them. The compiler may only
// depend on @holqa/core, so its tests never use @holqa/sdk.

/** How the fixture adapter describes one schema. */
interface FixtureDescription {
  readonly input: JsonObject;
  /** The output side; a string marks an unrepresentable output with that reason. */
  readonly output: JsonObject | string;
}

/** Descriptions of fixture schemas, keyed by schema object. */
const descriptions = new WeakMap<StandardSchemaV1, FixtureDescription>();

/**
 * Creates a Standard Schema of vendor `fixture` that accepts every value and
 * that {@link fixtureAdapter} describes with the given JSON Schema.
 *
 * @param input - The JSON Schema of the input (wire) side.
 * @param output - The output side's JSON Schema, or a reason string for an unrepresentable output. Defaults to `input`.
 * @returns A new schema object.
 */
export function fixtureSchema(input: JsonObject, output: JsonObject | string = input): StandardSchemaV1 {
  const schema: StandardSchemaV1 = { "~standard": { version: 1, vendor: "fixture", validate: value => ({ value }) } };
  descriptions.set(schema, { input, output });
  return schema;
}

/** The adapter for {@link fixtureSchema} schemas. */
export const fixtureAdapter: SchemaAdapter = {
  vendor: "fixture",
  library: "fixture@1",
  describe: (schema, side) => {
    const description = descriptions.get(schema);
    if (description === undefined)
      return err({ path: "$", reason: "unknown fixture schema" });
    const jsonSchema = side === "input" ? description.input : description.output;
    return typeof jsonSchema === "string" ? err({ path: "$", reason: jsonSchema }) : ok({ jsonSchema, runtimeOnly: [] });
  }
};

/**
 * Parses an identifier that a test knows to be valid.
 *
 * @param value - A valid identifier.
 * @returns The branded identifier.
 * @throws {Error} When the identifier is invalid, which indicates a broken test.
 */
export function id(value: string): ResourceId {
  const parsed = parseResourceId(value);
  if (!parsed.ok)
    throw new Error(parsed.error.message);
  return parsed.value;
}

/**
 * Wraps a descriptor the way handles and registrations carry it.
 *
 * @param descriptor - Any descriptor object.
 * @returns An object with the descriptor under `~holqa`.
 */
export function described<D>(descriptor: D): Described<D> {
  return { "~holqa": descriptor };
}

/**
 * Builds a queue descriptor.
 *
 * @param queueId - The queue identifier.
 * @param message - The message schema.
 * @param options - Schema version and delivery requirements.
 * @param options.schemaVersion - The message contract version; defaults to 1.
 * @param options.maxAttempts - The required maximum delivery attempts, when any.
 * @param options.deadLetter - Whether a dead-letter destination is required.
 * @returns The queue descriptor.
 */
export function queueResource(queueId: string, message: StandardSchemaV1, options: { readonly schemaVersion?: number; readonly maxAttempts?: number; readonly deadLetter?: boolean } = {}): ResourceDescriptor {
  return {
    protocol: 1,
    type: "resource",
    kind: "queue",
    id: id(queueId),
    config: { schemaVersion: options.schemaVersion ?? 1 },
    requirements: { delivery: "at-least-once", deadLetter: options.deadLetter ?? false, ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }) },
    schemas: { message }
  };
}

/**
 * Builds a bucket descriptor.
 *
 * @param bucketId - The bucket identifier.
 * @param access - The required access policy.
 * @returns The bucket descriptor.
 */
export function bucketResource(bucketId: string, access: "private" | "public-read" = "private"): ResourceDescriptor {
  return { protocol: 1, type: "resource", kind: "bucket", id: id(bucketId), config: {}, requirements: { access }, schemas: {} };
}

/**
 * Builds a schedule descriptor that runs nightly in UTC and skips overlapping runs.
 *
 * @param scheduleId - The schedule identifier.
 * @returns The schedule descriptor.
 */
export function scheduleResource(scheduleId: string): ResourceDescriptor {
  return { protocol: 1, type: "resource", kind: "schedule", id: id(scheduleId), config: { cron: "0 3 * * *", timezone: "UTC" }, requirements: { overlap: "skip" }, schemas: {} };
}

/**
 * Builds an HTTP API descriptor.
 *
 * @param apiId - The API identifier.
 * @param basePath - The base path of every route.
 * @returns The HTTP API descriptor.
 */
export function httpApiResource(apiId: string, basePath = "/api"): ResourceDescriptor {
  return { protocol: 1, type: "resource", kind: "http.api", id: id(apiId), config: { basePath }, requirements: {}, schemas: {} };
}

/**
 * Builds a configuration entry descriptor.
 *
 * @param name - The entry name, which is also its environment variable name.
 * @param schema - The schema the value must satisfy.
 * @param options - Whether it is a secret, and its default value.
 * @param options.sensitive - `true` for a secret.
 * @param options.defaultValue - The default value, when any.
 * @returns The configuration descriptor.
 */
export function configEntry(name: string, schema: StandardSchemaV1, options: { readonly sensitive?: boolean; readonly defaultValue?: JsonValue } = {}): ConfigDescriptor {
  return {
    protocol: 1,
    type: "config",
    name,
    sensitive: options.sensitive ?? false,
    schema,
    ...(options.defaultValue === undefined ? {} : { defaultValue: options.defaultValue })
  };
}

/**
 * Builds an application value as `defineApp` would return it.
 *
 * @param definition - The application's parts.
 * @param definition.name - The application name; defaults to `shop`.
 * @param definition.resources - The declared resources, in declaration order.
 * @param definition.config - The configuration entries, in declaration order.
 * @param definition.include - Handler discovery patterns.
 * @returns A value carrying an application descriptor.
 */
export function application(definition: { readonly name?: string; readonly resources: readonly ResourceDescriptor[]; readonly config?: readonly ConfigDescriptor[]; readonly include?: readonly string[] }): Described<AppDescriptor> {
  return described({
    protocol: 1,
    type: "app",
    name: id(definition.name ?? "shop"),
    handlers: { include: [...definition.include ?? ["src/**/*.handler.ts"]], exclude: [] },
    resources: definition.resources,
    config: definition.config ?? [],
    binding: createBindingSlot()
  });
}

/**
 * Stands in for a handler's executable part; the compiler never calls it.
 *
 * @returns A promise of `undefined`.
 */
const invoke = async (): Promise<unknown> => undefined;

/**
 * Builds a queue consumer registration.
 *
 * @param handlerId - The handler identifier.
 * @param queueId - The consumed queue.
 * @param message - The message schema the consumer validates with.
 * @param concurrency - Optional maximum concurrency.
 * @returns A value carrying a handler descriptor.
 */
export function queueConsumer(handlerId: string, queueId: string, message: StandardSchemaV1, concurrency?: number): Described<HandlerDescriptor> {
  return described({
    protocol: 1,
    type: "handler",
    definition: { id: id(handlerId), trigger: { kind: "queue.message", resource: { kind: "queue", id: id(queueId) }, options: concurrency === undefined ? {} : { concurrency } } },
    schemas: { message },
    invoke
  });
}

/** The portable object event schema used by object-created fixtures. */
export const objectEvent = fixtureSchema({ type: "object", properties: { key: { type: "string" }, size: { type: "integer" } }, required: ["key", "size"] });

/**
 * Builds an object-created handler registration.
 *
 * @param handlerId - The handler identifier.
 * @param bucketId - The watched bucket.
 * @param prefix - Optional key prefix filter.
 * @returns A value carrying a handler descriptor.
 */
export function objectCreatedHandler(handlerId: string, bucketId: string, prefix?: string): Described<HandlerDescriptor> {
  return described({
    protocol: 1,
    type: "handler",
    definition: { id: id(handlerId), trigger: { kind: "bucket.object-created", resource: { kind: "bucket", id: id(bucketId) }, options: prefix === undefined ? {} : { prefix } } },
    schemas: { object: objectEvent },
    invoke
  });
}

/**
 * Builds a schedule handler registration.
 *
 * @param handlerId - The handler identifier.
 * @param scheduleId - The schedule that runs it.
 * @returns A value carrying a handler descriptor.
 */
export function scheduleHandler(handlerId: string, scheduleId: string): Described<HandlerDescriptor> {
  return described({
    protocol: 1,
    type: "handler",
    definition: { id: id(handlerId), trigger: { kind: "schedule.tick", resource: { kind: "schedule", id: id(scheduleId) }, options: {} } },
    schemas: {},
    invoke
  });
}

/**
 * Builds an HTTP route registration, a trigger kind the SDK does not expose yet.
 *
 * @param handlerId - The handler identifier.
 * @param apiId - The API serving the route.
 * @param method - The HTTP method.
 * @param path - The path relative to the API's base path.
 * @param responses - Response schemas keyed by status code.
 * @returns A value carrying a handler descriptor.
 */
export function routeHandler(handlerId: string, apiId: string, method: HttpMethod, path: string, responses: Readonly<Record<number, StandardSchemaV1>> = {}): Described<HandlerDescriptor> {
  return described({
    protocol: 1,
    type: "handler",
    definition: { id: id(handlerId), trigger: { kind: "http.route", resource: { kind: "http.api", id: id(apiId) }, options: { method, path } } },
    schemas: { responses },
    invoke
  });
}

/**
 * Builds an RPC procedure handler.
 *
 * @param handlerId - The procedure identifier.
 * @param apiId - The API serving the procedure.
 * @param operation - Whether the procedure is a query or a mutation.
 * @param output - The output schema.
 * @param input - The input schema, if any.
 * @returns A value carrying a handler descriptor.
 */
export function procedureHandler(handlerId: string, apiId: string, operation: "query" | "mutation", output: StandardSchemaV1, input?: StandardSchemaV1): Described<HandlerDescriptor> {
  return described({
    protocol: 1,
    type: "handler",
    definition: { id: id(handlerId), trigger: { kind: "http.procedure", resource: { kind: "http.api", id: id(apiId) }, options: { operation } } },
    schemas: input === undefined ? { output } : { input, output },
    invoke
  });
}

/**
 * Builds an evaluated module.
 *
 * @param path - The root-relative module path.
 * @param exports - The module's exports by name.
 * @returns The evaluated module.
 */
export function module(path: string, exports: Readonly<Record<string, unknown>>): EvaluatedModule {
  return { path, exports };
}

/** The schemas of the shop fixture, shared so that consumers use their queue's contract. */
export const shopSchemas = {
  order: fixtureSchema({ type: "object", properties: { orderId: { type: "string" }, quantity: { type: "integer", minimum: 1 } }, required: ["orderId", "quantity"] }),
  databaseUrl: fixtureSchema({ type: "string", minLength: 1 }),
  logLevel: fixtureSchema({ enum: ["debug", "info", "warn"] })
};

/**
 * Builds the shop fixture: a queue with a consumer, a bucket with an
 * object-created handler, a schedule, an HTTP API with routes, a secret and a variable.
 *
 * @param options - Variations that must not change the manifest.
 * @param options.reverse - Declare resources, configuration and modules in reverse order.
 * @param options.renamed - Use other module paths and export names.
 * @returns The application value and its evaluated handler modules.
 */
export function shopFixture(options: { readonly reverse?: boolean; readonly renamed?: boolean } = {}): { readonly app: Described<AppDescriptor>; readonly modules: readonly EvaluatedModule[] } {
  /**
   * Applies the requested declaration order.
   *
   * @param values - Declarations in their natural order.
   * @returns A copy, reversed when `options.reverse` is set.
   */
  const order = <T>(values: readonly T[]): T[] => options.reverse === true ? [...values].reverse() : [...values];
  const resources = order([
    queueResource("order-placed", shopSchemas.order, { maxAttempts: 5, deadLetter: true }),
    bucketResource("receipts"),
    scheduleResource("nightly-report"),
    httpApiResource("shop-api")
  ]);
  const config = order([
    configEntry("DATABASE_URL", shopSchemas.databaseUrl, { sensitive: true }),
    configEntry("LOG_LEVEL", shopSchemas.logLevel, { defaultValue: "info" })
  ]);
  const consumer = queueConsumer("orders.process", "order-placed", shopSchemas.order, 4);
  const renamed = options.renamed === true;
  const modules = order([
    module(renamed ? "src/workers/fulfil.handler.ts" : "src/orders/process.handler.ts", renamed ? { processOrders: consumer } : { default: consumer, consumer }),
    module(renamed ? "src/files/receipt.handler.ts" : "src/receipts/stored.handler.ts", { [renamed ? "onReceipt" : "default"]: objectCreatedHandler("receipts.stored", "receipts", "incoming/") }),
    module(renamed ? "src/cron.handler.ts" : "src/reports/nightly.handler.ts", { [renamed ? "nightly" : "default"]: scheduleHandler("reports.nightly", "nightly-report") }),
    module(renamed ? "src/http.handler.ts" : "src/api/orders.handler.ts", {
      [renamed ? "show" : "getOrder"]: routeHandler("orders.get", "shop-api", "GET", "/orders/:orderId", { 200: shopSchemas.order }),
      [renamed ? "list" : "listOrders"]: routeHandler("orders.list", "shop-api", "GET", "/orders")
    })
  ]);
  return { app: application({ resources, config }), modules };
}