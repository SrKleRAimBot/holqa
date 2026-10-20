import { join } from "node:path";

import {
  defineApp,
  staticSite
} from "@holqa/sdk";
import {
  describe,
  expect,
  it
} from "bun:test";

import { createTestApp } from "@/app/create-test-app";

describe("createTestApp with a static site", () => {
  it("serves the site's files from the application root, with the SPA fallback", async () => {
    const web = staticSite({ id: "web", directory: "public", spa: true });
    const app = await createTestApp({ app: defineApp({ name: "storefront", resources: { web } }), handlers: [], root: join(import.meta.dir, "..", "fixtures", "site") });
    try {
      const home = await app.fetch("/");
      expect(home.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(await home.text()).toBe("<h1>shop</h1>");
      expect(await (await app.fetch("/products/42")).text()).toBe("<h1>shop</h1>");
      expect((await app.fetch("/missing.css")).status).toBe(404);
    } finally {
      await app.dispose();
    }
  });
});