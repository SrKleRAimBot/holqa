import {
  queueDescriptor,
  scheduleDescriptor
} from "@test/support/descriptors";
import {
  describe,
  expect,
  it
} from "bun:test";

import { checkCapabilities } from "@/resources/capabilities";

describe("checkCapabilities", () => {
  it("accepts capabilities that meet or exceed every requirement", () => {
    expect(checkCapabilities(queueDescriptor("orders", { maxAttempts: 5, deadLetter: true }), { queue: { delivery: ["at-least-once"], maxAttempts: 5, deadLetter: true } }, "local")).toEqual([]);
    expect(checkCapabilities(queueDescriptor("orders"), { queue: { delivery: ["at-least-once"], maxAttempts: 1, deadLetter: true } }, "local")).toEqual([]);
  });

  it("reports every unmet requirement instead of weakening it", () => {
    const diagnostics = checkCapabilities(queueDescriptor("orders", { maxAttempts: 10, deadLetter: true }), { queue: { delivery: [], maxAttempts: 3, deadLetter: false } }, "local");
    expect(diagnostics.map(diagnostic => diagnostic.code)).toEqual([
      "HOLQA_BINDING_CAPABILITY_UNSUPPORTED",
      "HOLQA_BINDING_CAPABILITY_UNSUPPORTED",
      "HOLQA_BINDING_CAPABILITY_UNSUPPORTED"
    ]);
    expect(diagnostics.map(diagnostic => diagnostic.message)).toEqual([
      "Binding \"local\" cannot satisfy queue \"orders\": at-least-once delivery is required.",
      "Binding \"local\" cannot satisfy queue \"orders\": 10 delivery attempts are required but at most 3 are supported.",
      "Binding \"local\" cannot satisfy queue \"orders\": a dead-letter destination is required."
    ]);
  });

  it("treats a kind without advertised capabilities as unsupported", () => {
    expect(checkCapabilities(scheduleDescriptor("nightly"), {}, "edge").map(diagnostic => diagnostic.message)).toEqual([
      "Binding \"edge\" does not support schedule resources, required by \"nightly\"."
    ]);
    expect(checkCapabilities(scheduleDescriptor("nightly"), { schedule: { overlap: ["allow"] } }, "edge")).toHaveLength(1);
  });

  it("checks a declared backoff against the strategies and delays a binding supports", () => {
    const exponential = queueDescriptor("orders", { backoff: { strategy: "exponential", initialDelaySeconds: 1, maxDelaySeconds: 600 } });
    const base = { delivery: ["at-least-once" as const], maxAttempts: 5, deadLetter: true };
    expect(checkCapabilities(exponential, { queue: { ...base, backoff: ["fixed", "exponential"], maxDelaySeconds: 900 } }, "local")).toEqual([]);
    expect(checkCapabilities(exponential, { queue: base }, "local").map(diagnostic => diagnostic.message)).toEqual([
      "Binding \"local\" cannot satisfy queue \"orders\": exponential backoff is required."
    ]);
    expect(checkCapabilities(exponential, { queue: { ...base, backoff: ["exponential"], maxDelaySeconds: 60 } }, "local").map(diagnostic => diagnostic.message)).toEqual([
      "Binding \"local\" cannot satisfy queue \"orders\": redelivery delays of 600 seconds are required but at most 60 are supported."
    ]);
    const fixed = queueDescriptor("orders", { backoff: { strategy: "fixed", delaySeconds: 5 } });
    expect(checkCapabilities(fixed, { queue: { ...base, backoff: ["fixed"], maxDelaySeconds: 5 } }, "local")).toEqual([]);
  });
});