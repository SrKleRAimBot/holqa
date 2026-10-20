import type {
  ResourceDescriptor,
  RuntimeBinding
} from "@holqa/core";

import { diagnosticsOf } from "@holqa/core";
import {
  apiResource,
  application,
  id,
  routeHandler
} from "@test/support/descriptors";

import {
  describe,
  expect,
  it
} from "bun:test";

import {
  createRuntime,
  silentSink
} from "@/index";

/**
 * Builds a static site descriptor.
 *
 * @param siteId - The site identifier.
 * @param basePath - Where it is served.
 * @returns The descriptor.
 */
function site(siteId: string, basePath: string): ResourceDescriptor {
  return { protocol: 1, type: "resource", kind: "static.site", id: id(siteId), config: { directory: "dist", basePath }, requirements: { spaFallback: false }, schemas: {} };
}

/** A binding whose static site driver answers known paths with the site and path. */
const binding: RuntimeBinding = {
  name: "test",
  capabilities: { "http.api": {}, "static.site": { spaFallback: true } },
  drivers: {
    "static.site": resource => ({
      fetch: async path => path === "/missing" ? undefined : new Response(`${resource.id}:${path}`, { headers: { "content-type": "text/plain" } })
    })
  },
  config: () => undefined
};

describe("static sites", () => {
  it("serves unmatched GET and HEAD requests from the site with the longest base path; routes win", async () => {
    const app = application([apiResource("api", "/api"), site("web", "/"), site("docs", "/docs")]);
    const runtime = createRuntime({ app, handlers: [routeHandler("ping", "api", "GET", "/ping")], binding, log: silentSink });
    await runtime.start();
    try {
      expect(await (await runtime.fetch(new Request("http://localhost/api/ping"))).text()).toBe("ok");
      expect(await (await runtime.fetch(new Request("http://localhost/index.html"))).text()).toBe("web:/index.html");
      expect(await (await runtime.fetch(new Request("http://localhost/docs"))).text()).toBe("docs:/");
      expect(await (await runtime.fetch(new Request("http://localhost/docs/intro"))).text()).toBe("docs:/intro");
      expect(await (await runtime.fetch(new Request("http://localhost/docsx"))).text()).toBe("web:/docsx");
      expect((await runtime.fetch(new Request("http://localhost/missing"))).status).toBe(404);
      expect((await runtime.fetch(new Request("http://localhost/index.html", { method: "POST" }))).status).toBe(404);
    } finally {
      await runtime.stop();
    }
  });

  it("rejects two sites under the same base path", () => {
    let codes: string[] = [];
    try {
      createRuntime({ app: application([site("web", "/"), site("other", "/")]), handlers: [], binding, log: silentSink });
    } catch (error) {
      codes = diagnosticsOf(error).map(diagnostic => diagnostic.code);
    }
    expect(codes).toEqual(["HOLQA_ROUTE_CONFLICT"]);
  });

  it("refuses to start with a binding that cannot host static sites", async () => {
    const runtime = createRuntime({ app: application([site("web", "/")]), handlers: [], env: {}, log: silentSink });
    await expect(runtime.start()).rejects.toThrow();
  });
});