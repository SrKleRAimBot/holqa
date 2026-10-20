import type { Diagnostic } from "@/index";

import {
  platformProvider,
  queueProvider
} from "@test/support/providers";
import {
  describe,
  expect,
  it
} from "bun:test";

import { validateProvider } from "@/binding/validate-provider";

/**
 * Summarizes diagnostics as `CODE: message` lines for readable assertions.
 *
 * @param diagnostics - The diagnostics to summarize.
 * @returns One line per diagnostic.
 */
function lines(diagnostics: readonly Diagnostic[]): string[] {
  return diagnostics.map(diagnostic => `${diagnostic.code}: ${diagnostic.message}`);
}

describe("validateProvider", () => {
  it("accepts well-formed resource and platform providers", () => {
    expect(validateProvider(queueProvider())).toEqual([]);
    expect(validateProvider(platformProvider())).toEqual([]);
  });

  it("rejects values that are not providers", () => {
    expect(validateProvider(42).map(diagnostic => diagnostic.code)).toEqual(["HOLQA_BINDING_CONFIG_INVALID"]);
    expect(validateProvider(null).map(diagnostic => diagnostic.code)).toEqual(["HOLQA_BINDING_CONFIG_INVALID"]);
  });

  it("rejects another provider protocol version as incompatible, without further checks", () => {
    const diagnostics = validateProvider(queueProvider({ bindingProtocol: 2, provider: "Not An Id" }));
    expect(lines(diagnostics)).toEqual([
      "HOLQA_BINDING_CONTRACT_INCOMPATIBLE: Provider \"example-queue\": it implements version 2 of the provider protocol, but this version of Holqa implements version 1."
    ]);
    expect(diagnostics[0]!.details).toEqual({ binding: "example-queue", failure: "version", transient: false });
  });

  it("rejects contract versions and contracts this version of Holqa does not implement", () => {
    expect(lines(validateProvider(queueProvider({ contracts: { queue: 2, topics: 1 } })))).toEqual([
      "HOLQA_BINDING_CONTRACT_INCOMPATIBLE: Provider \"example-queue\": it implements version 2 of the queue contract, but this version of Holqa implements version 1.",
      "HOLQA_BINDING_CONTRACT_INCOMPATIBLE: Provider \"example-queue\": it implements the topics contract, which this version of Holqa does not define."
    ]);
  });

  it("rejects malformed identifiers, roles and functions", () => {
    expect(validateProvider(queueProvider({ provider: "local", name: "Bad Name", role: "broker", open: "nope" })).map(diagnostic => diagnostic.message)).toEqual([
      "Provider \"Bad Name\": \"provider\" must be a namespaced identifier such as \"holqa.local\" or \"example.queue\".",
      "Provider \"Bad Name\": \"name\" must be lowercase letters, digits and hyphens, in dot-separated segments, at most 128 characters.",
      "Provider \"Bad Name\": \"open\" must be a function.",
      "Provider \"Bad Name\": \"role\" must be \"platform\", \"resource\" or \"service\"."
    ]);
  });

  it("requires a contract for every bound kind and supplied service, and the reverse", () => {
    expect(validateProvider(queueProvider({ contracts: { bucket: 1 }, services: { telemetry: true } })).map(diagnostic => diagnostic.message)).toEqual([
      "Provider \"example-queue\": it binds queue resources but does not declare the queue contract.",
      "Provider \"example-queue\": it supplies the telemetry service but does not declare the telemetry contract.",
      "Provider \"example-queue\": it declares the bucket contract but does not bind bucket resources."
    ]);
  });

  it("checks advertised capabilities against the kind registry", () => {
    const diagnostics = validateProvider(queueProvider({ resources: { queue: { delivery: ["exactly-once"], maxAttempts: 0, deadLetter: "yes", backoff: ["linear"] } } }));
    expect(diagnostics.map(diagnostic => diagnostic.message)).toEqual([
      "Provider \"example-queue\": its queue capabilities are malformed: \"delivery\" must be a list of \"at-least-once\".",
      "Provider \"example-queue\": its queue capabilities are malformed: \"maxAttempts\" must be a positive whole number.",
      "Provider \"example-queue\": its queue capabilities are malformed: \"deadLetter\" must be a boolean.",
      "Provider \"example-queue\": its queue capabilities are malformed: \"backoff\" must be a list of \"fixed\", \"exponential\"."
    ]);
  });

  it("keeps object events a separate contract from object storage", () => {
    const storage = { bindingProtocol: 1, provider: "example.storage", name: "storage", role: "resource", services: {}, open: async () => ({}) };
    expect(validateProvider({ ...storage, contracts: { bucket: 1 }, resources: { bucket: { access: ["private"], events: ["object.created"] } } }).map(diagnostic => diagnostic.message)).toEqual([
      "Provider \"storage\": it advertises object events but does not declare the bucket.events contract."
    ]);
    expect(validateProvider({ ...storage, contracts: { "bucket": 1, "bucket.events": 1 }, resources: { bucket: { access: ["private"] } } }).map(diagnostic => diagnostic.message)).toEqual([
      "Provider \"storage\": it declares the bucket.events contract but advertises no object event types."
    ]);
    expect(validateProvider({ ...storage, contracts: { bucket: 1 }, resources: { bucket: { access: ["private"] } } })).toEqual([]);
  });

  it("requires a complete platform to implement every mandatory contract and bind every kind", () => {
    expect(validateProvider(platformProvider({ contracts: { "execution": 1, "http.api": 1, "queue": 1, "config": 1, "telemetry": 1 } })).map(diagnostic => diagnostic.message)).toContain(
      "Provider \"platform\": a platform provider must implement every mandatory contract; it lacks bucket, bucket.events, schedule, static.site."
    );
    expect(validateProvider(platformProvider({ execution: undefined })).map(diagnostic => diagnostic.message)).toEqual([
      "Provider \"platform\": \"execution\" capabilities must be given exactly when the execution contract is declared."
    ]);
    expect(validateProvider(platformProvider({ execution: { runtimes: [], mode: "serverless", maxTimeoutMs: -1 } })).map(diagnostic => diagnostic.message)).toEqual([
      "Provider \"platform\": its execution capabilities are malformed: \"runtimes\" must be a non-empty list of runtime names.",
      "Provider \"platform\": its execution capabilities are malformed: \"mode\" must be \"long-running\" or \"request-driven\".",
      "Provider \"platform\": its execution capabilities are malformed: \"maxTimeoutMs\" must be a positive whole number."
    ]);
  });

  it("checks role-specific shape for resource and service providers", () => {
    expect(validateProvider(queueProvider({ contracts: {}, resources: {} })).map(diagnostic => diagnostic.message)).toEqual([
      "Provider \"example-queue\": a resource provider must bind at least one resource kind."
    ]);
    expect(validateProvider(queueProvider({ role: "service" })).map(diagnostic => diagnostic.message)).toEqual([
      "Provider \"example-queue\": a service provider must supply at least one service or extension and bind no resources."
    ]);
    expect(validateProvider(queueProvider({ role: "service", contracts: { telemetry: 1 }, resources: {}, services: { telemetry: true } }))).toEqual([]);
  });

  it("checks emulations, topology, settings and credentials", () => {
    const diagnostics = validateProvider(queueProvider({
      emulations: [{ kind: "bucket", capability: "queue", mechanism: "" }, { kind: "queue", capability: "queue.backoff.fixed", mechanism: "delay queues", requires: ["a delay queue"] }],
      topology: { delivery: "stream", state: "cloud" },
      settings: { when: new Date(0) },
      credentials: [{ type: "credential", name: "1BAD" }]
    }));
    expect(diagnostics.map(diagnostic => diagnostic.message)).toEqual([
      "Provider \"example-queue\": emulations[0] must name a resource kind the provider binds.",
      "Provider \"example-queue\": emulations[0].capability must be a capability of its kind, such as \"queue.backoff.exponential\".",
      "Provider \"example-queue\": emulations[0].mechanism must describe how the capability is emulated.",
      "Provider \"example-queue\": \"topology.delivery\" must be \"pull\", \"push\" or \"none\".",
      "Provider \"example-queue\": \"topology.state\" must be \"process\", \"host\" or \"shared\".",
      "Provider \"example-queue\": \"settings\" must be a plain JSON object.",
      "Provider \"example-queue\": \"credentials\" must be a list of credential references created with credentialRef."
    ]);
  });
});