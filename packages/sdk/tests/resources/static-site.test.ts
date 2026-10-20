import type { StaticSiteHandle } from "@/index";

import { getResourceDescriptor } from "@holqa/core";
import { thrownCodes } from "@test/support/test-binding";
import {
  describe,
  expect,
  expectTypeOf,
  it
} from "bun:test";

import {
  defineApp,
  staticSite
} from "@/index";

describe("staticSite", () => {
  it("declares a site with its artifact directory, base path and fallback requirement", () => {
    const web = staticSite({ id: "web", directory: "web/dist", spa: true });
    expectTypeOf(web).toEqualTypeOf<StaticSiteHandle<"web">>();
    expect<unknown>(getResourceDescriptor(web)).toMatchObject({ kind: "static.site", id: "web", config: { directory: "web/dist", basePath: "/" }, requirements: { spaFallback: true }, schemas: {} });
    expect<unknown>(getResourceDescriptor(staticSite({ id: "docs", directory: "docs", basePath: "/docs" }))).toMatchObject({ config: { directory: "docs", basePath: "/docs" }, requirements: { spaFallback: false } });
    expect(defineApp({ name: "shop", resources: { web } }).resources.web).toBe(web);
  });

  it.each([
    [{ id: "web", directory: "../outside" }],
    [{ id: "web", directory: "/abs/dist" }],
    [{ id: "web", directory: "web//dist" }],
    [{ id: "web", directory: "./dist" }],
    [{ id: "web", directory: "C:/dist" }],
    [{ id: "web", directory: "dist", basePath: "/app/" }],
    [{ id: "web", directory: "dist", spa: "yes" }]
  ])("rejects %p", (options) => {
    expect(thrownCodes(() => staticSite(options as never))).toEqual(["HOLQA_DECLARATION_INVALID"]);
  });

  it("rejects an invalid identifier at compile time and at run time", () => {
    /** Holds a deliberate type error checked by tsc; never executed. */
    const neverCalled = (): void => {
      // @ts-expect-error -- Identifiers are lowercase.
      staticSite({ id: "Web", directory: "dist" });
    };
    expect(neverCalled).toBeFunction();
    expect(thrownCodes(() => staticSite({ id: "Web" as never, directory: "dist" }))).toEqual(["HOLQA_RESOURCE_ID_INVALID"]);
  });
});