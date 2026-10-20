import {
  describe,
  expect,
  it
} from "bun:test";

import {
  bindingContractNames,
  bindingContracts,
  bindingProtocolVersion,
  contractVersionProblem,
  isBindingContractName,
  mandatoryBindingContracts
} from "@/binding/contracts";

describe("binding contracts", () => {
  it("pins the protocol and every contract version; changing one is a breaking change for providers", () => {
    expect(bindingProtocolVersion).toBe(1);
    expect(bindingContracts).toEqual({
      "execution": 1,
      "http.api": 1,
      "queue": 1,
      "bucket": 1,
      "bucket.events": 1,
      "schedule": 1,
      "static.site": 1,
      "config": 1,
      "telemetry": 1,
      "idempotency": 1,
      "operation-budgets": 1
    });
    expect(Object.keys(bindingContracts)).toEqual([...bindingContractNames]);
  });

  it("makes every contract mandatory for a platform except the optional event safety stores", () => {
    expect(mandatoryBindingContracts).toEqual(["execution", "http.api", "queue", "bucket", "bucket.events", "schedule", "static.site", "config", "telemetry"]);
    expect(mandatoryBindingContracts.every(isBindingContractName)).toBe(true);
  });

  it("recognizes contract names", () => {
    expect(isBindingContractName("bucket.events")).toBe(true);
    expect(isBindingContractName("topics")).toBe(false);
    expect(isBindingContractName("toString")).toBe(false);
  });

  it("accepts only the exact implemented version", () => {
    expect(contractVersionProblem("queue", 1)).toBeUndefined();
    expect(contractVersionProblem("queue", 2)).toBe("it implements version 2 of the queue contract, but this version of Holqa implements version 1");
    expect(contractVersionProblem("queue", 0)).toBe("the queue contract version must be a positive whole number, not 0");
    expect(contractVersionProblem("queue", "1")).toBe("the queue contract version must be a positive whole number, not \"1\"");
    expect(contractVersionProblem("queue", undefined)).toBe("the queue contract version must be a positive whole number, not undefined");
  });
});