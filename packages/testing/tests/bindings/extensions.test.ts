import {
  createBinding,
  defineBindings,
  inspectBindings,
  resolveBindings,
  validateBindings
} from "@holqa/bindings";
import {
  defineExtension,
  diagnosticsOf
} from "@holqa/core";
import {
  appCacheExtension,
  localAppCache,
  localEnvironment
} from "@holqa/local";
import {
  createRuntime,
  silentSink
} from "@holqa/runtime-bun";
import {
  defineApp,
  http
} from "@holqa/sdk";
import {
  describe,
  expect,
  expectTypeOf,
  it
} from "bun:test";

/** An optional extension no provider implements. */
const recommendations = defineExtension<{ readonly forProduct: (id: string) => Promise<readonly string[]> }>({ id: "example.recommendations", version: 1 });

/**
 * Builds an application with a route that caches product names in the
 * required cache and falls back without the optional recommendations.
 *
 * @returns The application and its route.
 */
function storefront() {
  const api = http.api({ id: "api", basePath: "/" });
  const app = defineApp({ name: "storefront", resources: { api }, extensions: { required: [appCacheExtension], optional: [recommendations] } });
  const product = api.route({
    id: "products.get",
    method: "GET",
    path: "/products/:id",
    responses: { 200: { "~standard": { version: 1, vendor: "test", validate: (value: unknown) => ({ value }) } } },
    handler: async ({ params, reply }) => {
      const cache = app.extensions.require(appCacheExtension);
      const cached = await cache.get(`product:${params.id}`);
      const name = cached ?? `Product ${params.id}`;
      if (cached === undefined)
        await cache.set(`product:${params.id}`, name, { ttlSeconds: 60 });
      const related = await app.extensions.get(recommendations)?.forProduct(params.id) ?? [];
      return reply(200, { name, cached: cached !== undefined, related });
    }
  });
  return { app, product };
}

describe("provider extensions end to end", () => {
  it("resolves the required extension through the binding, lets the optional one be absent and keeps types", async () => {
    const { app, product } = storefront();
    expectTypeOf<ReturnType<typeof app.extensions.require<typeof appCacheExtension>>["get"]>().returns.toEqualTypeOf<Promise<string | undefined>>();
    const env = localEnvironment({ persistence: "memory", env: {} });
    const cache = localAppCache();
    const resolved = resolveBindings(defineBindings(app, { defaults: env.platform(), extensions: [cache] }));
    expect(validateBindings(resolved)).toEqual([]);
    expect(inspectBindings(resolved).extensions).toEqual([{ id: "holqa.app-cache", version: 1, provider: "local.app-cache", selection: "extension", required: true }]);
    const runtime = createRuntime({ app, handlers: [product], binding: createBinding(resolved), log: silentSink });
    await runtime.start();
    try {
      expect(await (await runtime.fetch(new Request("http://localhost/products/7"))).json()).toEqual({ name: "Product 7", cached: false, related: [] });
      expect(await (await runtime.fetch(new Request("http://localhost/products/7"))).json()).toEqual({ name: "Product 7", cached: true, related: [] });
      expect((await runtime.health()).components.map(component => component.name)).toContain("local.app-cache");
    } finally {
      await runtime.stop();
    }
  });

  it("rejects a binding without a required extension, before and at start", async () => {
    const { app, product } = storefront();
    const env = localEnvironment({ persistence: "memory", env: {} });
    const resolved = resolveBindings(defineBindings(app, { defaults: env.platform() }));
    expect(validateBindings(resolved).map(diagnostic => diagnostic.code)).toEqual(["HOLQA_EXTENSION_MISSING"]);
    const runtime = createRuntime({ app, handlers: [product], binding: createBinding(resolved), log: silentSink });
    let codes: string[] = [];
    try {
      await runtime.start();
    } catch (error) {
      codes = diagnosticsOf(error).map(diagnostic => diagnostic.code);
    }
    expect(codes).toEqual(["HOLQA_RUNTIME_START_FAILED", "HOLQA_EXTENSION_MISSING"]);
    expect(env.state()).toBeUndefined();
  });

  it("rejects an implementation of another version and an unmet dependency", () => {
    const { app } = storefront();
    const env = localEnvironment({ persistence: "memory", env: {} });
    const newer = { ...localAppCache(), extensions: [{ id: "holqa.app-cache", version: 2, dependsOn: [{ id: "example.clock", version: 1 }] }] };
    const resolved = resolveBindings(defineBindings(app, { defaults: env.platform(), extensions: [newer] }));
    expect(validateBindings(resolved).map(diagnostic => diagnostic.code)).toEqual(["HOLQA_EXTENSION_INCOMPATIBLE", "HOLQA_EXTENSION_MISSING"]);
  });

  it("disposes of the extension with the binding and never hands it undeclared credentials", async () => {
    const { app, product } = storefront();
    const env = localEnvironment({ persistence: "memory", env: { SECRET_TOKEN: "s3cr3t-value" } });
    let attempted: unknown;
    const prying = {
      ...localAppCache({ name: "prying-cache" }),
      open: async (context: Parameters<ReturnType<typeof localAppCache>["open"]>[0]) => {
        try {
          context.credential({ type: "credential", name: "SECRET_TOKEN" });
        } catch (error) {
          attempted = error;
        }
        return localAppCache().open(context);
      }
    };
    const runtime = createRuntime({ app, handlers: [product], binding: createBinding(resolveBindings(defineBindings(app, { defaults: env.platform(), extensions: [prying] }))), log: silentSink });
    await runtime.start();
    await runtime.stop();
    expect(diagnosticsOf(attempted).map(diagnostic => diagnostic.code)).toEqual(["HOLQA_BINDING_CONFIG_INVALID"]);
    expect(JSON.stringify(diagnosticsOf(attempted))).not.toContain("s3cr3t-value");
    expect(env.state()).toBeUndefined();
  });
});