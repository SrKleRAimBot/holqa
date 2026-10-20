import type { ProviderContext } from "@holqa/core";

import {
  diagnosticsOf,
  getResourceDescriptor,
  validateProvider
} from "@holqa/core";

import app from "@test/support/app";

import {
  describe,
  expect,
  it
} from "bun:test";
import { container } from "@/host";

describe("container.host", () => {
  it("is a valid long-running Bun execution host for HTTP APIs and static sites", () => {
    const host = container.host({ maxConcurrency: 64 });
    expect(validateProvider(host)).toEqual([]);
    expect(host.contracts).toEqual({ "execution": 1, "http.api": 1, "static.site": 1 });
    expect(host.execution).toEqual({ runtimes: ["bun"], mode: "long-running", maxConcurrency: 64 });
    expect(host.settings).toEqual({ root: "." });
    expect(host.credentials).toBeUndefined();
  });

  it("serves static files from its root, never outside it", async () => {
    const instance = await container.host({ root: `${import.meta.dir}/support` }).open({} as ProviderContext);
    const descriptor = getResourceDescriptor(app.resources.web);
    const driver = instance.drivers!["static.site"]!(descriptor as never);
    const index = await driver.fetch("/", new Request("http://host/"));
    expect(await index?.text()).toContain("<p>web</p>");
    expect(await (await driver.fetch("/orders/42", new Request("http://host/orders/42")))?.text()).toContain("<p>web</p>");
    expect(await driver.fetch("/../app.ts", new Request("http://host/"))).toBeUndefined();
  });

  it("rejects invalid limits", () => {
    let codes: string[] = [];
    try {
      container.host({ maxConcurrency: 0, maxTimeoutMs: 1.5 });
    } catch (error) {
      codes = diagnosticsOf(error).map(diagnostic => diagnostic.code);
    }
    expect(codes).toEqual(["HOLQA_BINDING_CONFIG_INVALID", "HOLQA_BINDING_CONFIG_INVALID"]);
  });
});