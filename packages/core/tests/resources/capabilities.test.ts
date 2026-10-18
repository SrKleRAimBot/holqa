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
});