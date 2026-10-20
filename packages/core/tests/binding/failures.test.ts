import type { BindingFailureKind } from "@/index";

import {
  describe,
  expect,
  it
} from "bun:test";

import {
  bindingFailure,
  bindingFailureCodes,
  isTransientBindingFailure
} from "@/binding/failures";

describe("bindingFailure", () => {
  it("gives every failure kind its own code, so tools never parse messages", () => {
    expect(bindingFailureCodes).toEqual({
      "configuration": "HOLQA_BINDING_CONFIG_INVALID",
      "credentials-missing": "HOLQA_BINDING_CREDENTIALS_MISSING",
      "credentials-invalid": "HOLQA_BINDING_CREDENTIALS_INVALID",
      "capability": "HOLQA_BINDING_CAPABILITY_UNSUPPORTED",
      "version": "HOLQA_BINDING_CONTRACT_INCOMPATIBLE",
      "unavailable": "HOLQA_BINDING_UNAVAILABLE",
      "failed": "HOLQA_BINDING_FAILED"
    });
  });

  it("records the binding, the failure kind and whether retrying may help", () => {
    const diagnostic = bindingFailure("unavailable", { binding: "rabbitmq", message: "The broker refused the connection.", hint: "Check that the broker is running.", details: { host: "broker" } });
    expect(diagnostic).toEqual({
      code: "HOLQA_BINDING_UNAVAILABLE",
      severity: "error",
      message: "The broker refused the connection.",
      hint: "Check that the broker is running.",
      details: { host: "broker", binding: "rabbitmq", failure: "unavailable", transient: true }
    });
    expect(Object.isFrozen(diagnostic)).toBe(true);
  });

  it("does not let details override the classification", () => {
    const diagnostic = bindingFailure("failed", { binding: "s3", message: "The bucket does not exist.", details: { transient: true, binding: "other" } });
    expect(diagnostic.details).toEqual({ transient: false, binding: "s3", failure: "failed" });
  });

  it.each([
    ["unavailable", true],
    ["configuration", false],
    ["credentials-missing", false],
    ["credentials-invalid", false],
    ["capability", false],
    ["version", false],
    ["failed", false]
  ] as const)("classifies %s failures as transient: %p", (kind: BindingFailureKind, transient) => {
    expect(isTransientBindingFailure(bindingFailure(kind, { binding: "b", message: "m" }))).toBe(transient);
  });
});