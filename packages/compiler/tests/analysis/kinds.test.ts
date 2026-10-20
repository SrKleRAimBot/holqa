import type { ResourceKind } from "@holqa/core";

import { resourceKinds } from "@holqa/core";
import { fixtureSchema } from "@test/support/application";

import {
  describe,
  expect,
  it
} from "bun:test";
import {
  normalizeResourceKind,
  normalizeTriggerKind,
  resourceSchemas,
  triggerSchemas
} from "@/analysis/kinds";

describe("normalizeResourceKind", () => {
  it("has a rule for every registered resource kind", () => {
    for (const kind of resourceKinds)
      expect(() => normalizeResourceKind(kind as ResourceKind, {}, {})).not.toThrow();
  });

  it("copies known settings and derives capabilities", () => {
    expect(normalizeResourceKind("queue", { schemaVersion: 2 }, { delivery: "at-least-once", deadLetter: false })).toEqual({
      config: { schemaVersion: 2 },
      requirements: { delivery: "at-least-once", deadLetter: false },
      capabilities: ["queue", "queue.delivery.at-least-once"],
      problems: []
    });
    expect(normalizeResourceKind("http.api", { basePath: "/", docs: { title: "T", version: "1" } }, {}).config).toEqual({ basePath: "/", docs: { title: "T", version: "1" } });
    expect(normalizeResourceKind("static.site", { directory: "web/dist", basePath: "/" }, { spaFallback: true })).toEqual({
      config: { directory: "web/dist", basePath: "/" },
      requirements: { spaFallback: true },
      capabilities: ["static.site", "static.site.spa-fallback"],
      problems: []
    });
  });

  it("records a queue's backoff and the capability it requires", () => {
    const exponential = { strategy: "exponential", initialDelaySeconds: 1, maxDelaySeconds: 30, multiplier: 3 } as const;
    expect(normalizeResourceKind("queue", { schemaVersion: 1 }, { delivery: "at-least-once", deadLetter: true, maxAttempts: 4, backoff: exponential })).toEqual({
      config: { schemaVersion: 1 },
      requirements: { delivery: "at-least-once", deadLetter: true, maxAttempts: 4, backoff: exponential },
      capabilities: ["queue", "queue.delivery.at-least-once", "queue.dead-letter", "queue.max-attempts", "queue.backoff.exponential"],
      problems: []
    });
    expect(normalizeResourceKind("queue", { schemaVersion: 1 }, { delivery: "at-least-once", deadLetter: false, backoff: { strategy: "fixed", delaySeconds: 5 } }).requirements).toEqual({
      delivery: "at-least-once",
      deadLetter: false,
      backoff: { strategy: "fixed", delaySeconds: 5 }
    });
    expect(normalizeResourceKind("queue", { schemaVersion: 1 }, { delivery: "at-least-once", deadLetter: false, backoff: { strategy: "fixed", delaySeconds: -1, jitter: true } }).problems).toEqual([
      "\"requirements.backoff.jitter\" is not a recognized setting.",
      "\"requirements.backoff.delaySeconds\" must be a number of at least 0."
    ]);
    expect(normalizeResourceKind("queue", { schemaVersion: 1 }, { delivery: "at-least-once", deadLetter: false, backoff: { strategy: "exponential", initialDelaySeconds: 1, maxDelaySeconds: 30, multiplier: 0.5 } }).problems).toEqual([
      "\"requirements.backoff\" is invalid: \"multiplier\" must be a number of at least 1."
    ]);
    expect(normalizeResourceKind("queue", { schemaVersion: 1 }, { delivery: "at-least-once", deadLetter: false, backoff: { strategy: "exponential", initialDelaySeconds: 10, maxDelaySeconds: 5 } }).problems).toHaveLength(1);
  });

  it.each([
    ["queue", { schemaVersion: 0 }, { delivery: "at-least-once", deadLetter: false }, "\"config.schemaVersion\" must be a positive integer."],
    ["queue", { schemaVersion: 1 }, { delivery: "exactly-once", deadLetter: false }, "\"requirements.delivery\" must be one of \"at-least-once\"."],
    ["bucket", { region: "x" }, { access: "private" }, "\"config.region\" is not a recognized setting."],
    ["schedule", { cron: "0 3 * *", timezone: "UTC" }, { overlap: "skip" }, "\"config.cron\" must be a five-field cron expression separated by single spaces."],
    ["http.api", { basePath: "/api/" }, {}, "\"config.basePath\" must be \"/\" or a path such as \"/api\" that starts with \"/\" and does not end with one."],
    ["http.api", { basePath: "/" }, null, "\"requirements\" must be an object."],
    ["static.site", { directory: "../outside", basePath: "/" }, { spaFallback: false }, "\"config.directory\" must be a relative path such as \"web/dist\" with \"/\" separators and no empty, \".\" or \"..\" segments."],
    ["static.site", { directory: "dist", basePath: "/" }, { spaFallback: "yes" }, "\"requirements.spaFallback\" must be a boolean."]
  ] as const)("reports a malformed %p", (kind, config, requirements, problem) => {
    expect(normalizeResourceKind(kind, config, requirements).problems).toContain(problem);
  });
});

describe("normalizeTriggerKind", () => {
  it("keeps defined options only and names the trigger capability", () => {
    expect(normalizeTriggerKind("queue.message", {})).toEqual({ options: {}, capabilities: ["trigger.queue.message"], problems: [] });
    expect(normalizeTriggerKind("http.route", { method: "GET", path: "/orders/:id" }).options).toEqual({ method: "GET", path: "/orders/:id" });
    expect(normalizeTriggerKind("http.procedure", { operation: "mutation" })).toEqual({ options: { operation: "mutation" }, capabilities: ["trigger.http.procedure"], problems: [] });
  });

  it("rejects malformed options", () => {
    expect(normalizeTriggerKind("http.route", { method: "TRACE", path: "/a" }).problems).toHaveLength(1);
    expect(normalizeTriggerKind("bucket.object-created", { prefix: 3 }).problems).toEqual(["\"options.prefix\" must be a string."]);
    expect(normalizeTriggerKind("bucket.object-deleted", { prefix: 3 }).problems).toEqual(["\"options.prefix\" must be a string."]);
    expect(normalizeTriggerKind("bucket.object-deleted", { prefix: "raw/" })).toEqual({ options: { prefix: "raw/" }, capabilities: ["trigger.bucket.object-deleted"], problems: [] });
    expect(normalizeTriggerKind("http.procedure", { operation: "subscription" }).problems).toEqual(["\"options.operation\" must be one of \"query\", \"mutation\"."]);
  });
});

describe("schema roles", () => {
  const schema = fixtureSchema({ type: "string" });

  it("lists roles sorted and flattens responses", () => {
    expect(triggerSchemas("http.route", { query: schema, body: schema, headers: schema, responses: { 404: schema, 200: schema } }).roles.map(entry => entry.role)).toEqual(["body", "headers", "query", "response.200", "response.404"]);
    expect(triggerSchemas("http.procedure", { input: schema, output: schema }).roles.map(entry => entry.role)).toEqual(["input", "output"]);
  });

  it("reports missing, unknown and non-schema roles", () => {
    expect(resourceSchemas("queue", {}).problems).toEqual(["\"schemas.message\" is required."]);
    expect(resourceSchemas("bucket", { message: schema }).problems).toEqual(["\"schemas.message\" is not a recognized setting."]);
    expect(triggerSchemas("queue.message", { message: 1 }).problems).toEqual(["\"schemas.message\" must be a Standard Schema."]);
    expect(triggerSchemas("http.route", { responses: { 999: schema } }).problems).toEqual(["\"schemas.responses.999\" is not a recognized setting."]);
    expect(triggerSchemas("http.procedure", { input: schema }).problems).toEqual(["\"schemas.output\" is required."]);
  });
});