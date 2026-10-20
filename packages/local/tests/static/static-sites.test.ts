import type { ResourceDescriptorOf } from "@holqa/core";

import {
  mkdirSync,
  writeFileSync
} from "node:fs";
import { join } from "node:path";

import {
  id,
  stateDirectory
} from "@test/support/fixtures";
import {
  afterAll,
  describe,
  expect,
  it
} from "bun:test";

import {
  contentTypeOf,
  createLocalStaticSites
} from "@/static/static-sites";

const root = stateDirectory();
mkdirSync(join(root.path, "web", "dist", "assets"), { recursive: true });
mkdirSync(join(root.path, "web", "dist", "guide"), { recursive: true });
writeFileSync(join(root.path, "web", "dist", "index.html"), "<h1>home</h1>");
writeFileSync(join(root.path, "web", "dist", "guide", "index.html"), "<h1>guide</h1>");
writeFileSync(join(root.path, "web", "dist", "assets", "app.js"), "console.log(1)");
writeFileSync(join(root.path, "web", "secret.txt"), "outside the site");

afterAll(() => root.remove());

/**
 * Builds a static site descriptor.
 *
 * @param spaFallback - Whether the site requires the fallback.
 * @returns The descriptor.
 */
function site(spaFallback: boolean): ResourceDescriptorOf<"static.site"> {
  return { protocol: 1, type: "resource", kind: "static.site", id: id("web"), config: { directory: "web/dist", basePath: "/" }, requirements: { spaFallback }, schemas: {} };
}

/**
 * Fetches a path from a site.
 *
 * @param spaFallback - Whether the site requires the fallback.
 * @param path - The path relative to the site.
 * @param method - The request method.
 * @returns The response, or `undefined`.
 */
async function get(spaFallback: boolean, path: string, method = "GET"): Promise<Response | undefined> {
  return createLocalStaticSites(root.path)(site(spaFallback)).fetch(path, new Request(`http://localhost${path}`, { method }));
}

describe("createLocalStaticSites", () => {
  it("serves files with content types, and directories with their index", async () => {
    const script = await get(false, "/assets/app.js");
    expect(script?.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(await script?.text()).toBe("console.log(1)");
    const home = await get(false, "/");
    expect(home?.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(home?.headers.get("cache-control")).toBe("no-cache");
    expect(await home?.text()).toBe("<h1>home</h1>");
    expect(await (await get(false, "/guide"))?.text()).toBe("<h1>guide</h1>");
  });

  it("answers HEAD without a body", async () => {
    const head = await get(false, "/assets/app.js", "HEAD");
    expect(head?.headers.get("content-length")).toBe("14");
    expect(await head?.text()).toBe("");
  });

  it("falls back to index.html for unknown extension-less paths only when required", async () => {
    expect(await get(false, "/orders/42")).toBeUndefined();
    expect(await (await get(true, "/orders/42"))?.text()).toBe("<h1>home</h1>");
    expect(await get(true, "/missing.js")).toBeUndefined();
  });

  it("never serves files outside the site's directory", async () => {
    for (const path of ["/../secret.txt", "/%2e%2e/secret.txt", "/assets/../../secret.txt", "/%00", "/%E0%A4%A"])
      expect(await get(false, path)).toBeUndefined();
  });

  it("maps unknown extensions to bytes", () => {
    expect(contentTypeOf("a.unknown")).toBe("application/octet-stream");
    expect(contentTypeOf("A.SVG")).toBe("image/svg+xml");
  });
});