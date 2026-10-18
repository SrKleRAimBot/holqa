import {
  describe,
  expect,
  it
} from "bun:test";

import {
  defineApp,
  http,
  middleware
} from "@/index";
import { appMiddlewareOf } from "@/internal/app-middleware";

describe("application middleware registry", () => {
  it("records the middleware of each application instance, in order", () => {
    const first = middleware({ name: "first", handle: ({ next }) => next() });
    const second = middleware({ name: "second", handle: ({ next }) => next() });
    const app = defineApp({ name: "registry", resources: { api: http.api({ id: "registry-api", basePath: "/" }) }, middleware: [first, second] });
    expect(appMiddlewareOf(app["~holqa"]).map(entry => entry.name)).toEqual(["first", "second"]);
    expect(appMiddlewareOf(defineApp({ name: "bare", resources: {} })["~holqa"])).toEqual([]);
  });
});