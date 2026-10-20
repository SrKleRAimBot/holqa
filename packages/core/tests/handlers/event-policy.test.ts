import {
  describe,
  expect,
  it
} from "bun:test";

import { diagnosticCodes } from "@/diagnostics/codes";
import {
  defaultEventLimits,
  eventPolicyProblems,
  idempotencyPolicyProblems,
  isEventGuardCode
} from "@/handlers/event-policy";

describe("eventPolicyProblems", () => {
  it("accepts an absent or complete policy", () => {
    expect(eventPolicyProblems(undefined)).toEqual([]);
    expect(eventPolicyProblems({ publishes: [{ kind: "queue", id: "orders" }], cycle: { justification: "Stops at status done." }, maxPublications: 2, maxDepth: 4 })).toEqual([]);
  });

  it("reports every problem at once", () => {
    expect(eventPolicyProblems({ publishes: [{ kind: "topic", id: "x" }], cycle: { justification: " " }, maxPublications: 0, maxDepth: 1.5, other: true })).toHaveLength(5);
    expect(eventPolicyProblems("x")).toEqual(["\"events\" must be an object."]);
    expect(eventPolicyProblems({ publishes: "orders" })).toHaveLength(1);
    expect(eventPolicyProblems({ cycle: { justification: "x".repeat(501) } })).toHaveLength(1);
  });
});

describe("idempotencyPolicyProblems", () => {
  it("accepts an absent or complete policy and rejects malformed ones", () => {
    expect(idempotencyPolicyProblems(undefined)).toEqual([]);
    expect(idempotencyPolicyProblems({ key: "delivery", retentionSeconds: 60, leaseSeconds: 30 })).toEqual([]);
    expect(idempotencyPolicyProblems({ key: "other", retentionSeconds: 0 })).toHaveLength(3);
    expect(idempotencyPolicyProblems([])).toHaveLength(1);
  });
});

describe("event guards", () => {
  it("treats only event guard codes as terminal", () => {
    expect(isEventGuardCode(diagnosticCodes.eventDepthExceeded)).toBe(true);
    expect(isEventGuardCode(diagnosticCodes.eventPublicationLimitExceeded)).toBe(true);
    expect(isEventGuardCode(diagnosticCodes.eventAgeExceeded)).toBe(true);
    expect(isEventGuardCode(diagnosticCodes.executionBudgetExceeded)).toBe(true);
    expect(isEventGuardCode(diagnosticCodes.handlerFailed)).toBe(false);
    expect(isEventGuardCode(diagnosticCodes.idempotencyInProgress)).toBe(false);
  });

  it("pins the default limits", () => {
    expect(defaultEventLimits).toEqual({ maxDepth: 16, maxPublications: 1000 });
  });
});