import { diagnosticsOf } from "@holqa/core";

import {
  describe,
  expect,
  it
} from "bun:test";

import { readContainerSettings } from "@/settings";

describe("readContainerSettings", () => {
  it("uses container defaults: every interface, port 3000", () => {
    expect(readContainerSettings({})).toEqual({ port: 3000, hostname: "0.0.0.0", graceMs: 10_000, forceMs: 1_000, maxRequestBodySize: 1_048_576 });
  });

  it("reads PORT, HOST and the shutdown periods", () => {
    expect(readContainerSettings({ PORT: "8080", HOST: "127.0.0.1", HOLQA_SHUTDOWN_GRACE_MS: "25000", HOLQA_SHUTDOWN_FORCE_MS: "0", HOLQA_MAX_REQUEST_BODY_BYTES: "2048" })).toEqual({ port: 8080, hostname: "127.0.0.1", graceMs: 25_000, forceMs: 0, maxRequestBodySize: 2048 });
  });

  it("reports every invalid variable by name", () => {
    let details: unknown[] = [];
    try {
      readContainerSettings({ PORT: "eighty", HOST: "bad host", HOLQA_SHUTDOWN_GRACE_MS: "-1" });
    } catch (error) {
      details = diagnosticsOf(error).map(diagnostic => [diagnostic.code, (diagnostic.details as { readonly variable?: unknown } | undefined)?.variable]);
    }
    expect(details).toEqual([["HOLQA_CONTAINER_SETTINGS_INVALID", "PORT"], ["HOLQA_CONTAINER_SETTINGS_INVALID", "HOLQA_SHUTDOWN_GRACE_MS"], ["HOLQA_CONTAINER_SETTINGS_INVALID", "HOST"]]);
  });
});