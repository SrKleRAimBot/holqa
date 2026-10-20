import type { ConfigDescriptor } from "@/index";

import { stringSchema } from "@test/support/descriptors";
import {
  describe,
  expect,
  it
} from "bun:test";

import { resolveConfiguration } from "@/binding/configuration";
import { diagnosticsOf } from "@/errors/holqa-error";

const entries: readonly ConfigDescriptor[] = [
  { protocol: 1, type: "config", name: "API_TOKEN", sensitive: true, schema: stringSchema },
  { protocol: 1, type: "config", name: "REGION", sensitive: false, schema: stringSchema, defaultValue: "eu" }
];

describe("resolveConfiguration", () => {
  it("validates every entry and applies declared defaults", async () => {
    const values = await resolveConfiguration(entries, name => name === "API_TOKEN" ? "token" : undefined);
    expect([...values]).toEqual([["API_TOKEN", "token"], ["REGION", "eu"]]);
  });

  it("reports every invalid entry without secret values, with a configurable hint", async () => {
    let failure: unknown;
    try {
      await resolveConfiguration(entries, name => name === "REGION" ? 42 : undefined, { hint: "Add a secret file named" });
    } catch (error) {
      failure = error;
    }
    expect(diagnosticsOf(failure).map(diagnostic => [diagnostic.code, diagnostic.hint, diagnostic.details])).toEqual([
      ["HOLQA_CONFIG_INVALID", "Add a secret file named API_TOKEN before starting the application.", { name: "API_TOKEN", kind: "secret", missing: true }],
      ["HOLQA_CONFIG_INVALID", "Add a secret file named REGION before starting the application.", { name: "REGION", kind: "variable", missing: false }]
    ]);
  });
});