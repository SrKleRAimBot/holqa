import type { HttpApiHandle } from "@/index";

import { getResourceDescriptor } from "@holqa/core";
import { thrownCodes } from "@test/support/test-binding";
import {
  describe,
  expect,
  expectTypeOf,
  it
} from "bun:test";

import { http } from "@/index";

describe("http.api", () => {
  it("declares an API resource without opening anything", () => {
    const api = http.api({ id: "public-api", basePath: "/api", docs: { title: "Public API", version: "1.0.0" } });
    expectTypeOf(api).toEqualTypeOf<HttpApiHandle<"public-api">>();
    expect(getResourceDescriptor(api)?.config).toEqual({ basePath: "/api", docs: { title: "Public API", version: "1.0.0" } });
    expect(getResourceDescriptor(http.api({ id: "root", basePath: "/" }))?.config).toEqual({ basePath: "/" });
  });

  it("rejects malformed base paths and documentation", () => {
    /** Holds deliberate type errors checked by tsc; never executed. */
    const neverCalled = (): void => {
      // @ts-expect-error -- `basePath` is required.
      http.api({ id: "no-base" });
      // @ts-expect-error -- documentation needs a version.
      http.api({ id: "docs", basePath: "/", docs: { title: "API" } });
    };
    expect(typeof neverCalled).toBe("function");
    expect(thrownCodes(() => http.api({ id: "trailing", basePath: "/api/" }))).toEqual(["HOLQA_DECLARATION_INVALID"]);
    expect(thrownCodes(() => http.api({ id: "relative", basePath: "api", docs: { title: "", version: "1" } }))).toEqual(["HOLQA_DECLARATION_INVALID", "HOLQA_DECLARATION_INVALID"]);
  });
});