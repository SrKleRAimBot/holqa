import {
  describe,
  expect,
  it
} from "bun:test";

import {
  backoffDelaySeconds,
  defaultQueueBackoff,
  longestBackoffDelaySeconds,
  queueBackoffProblem
} from "@/resources/backoff";

describe("backoffDelaySeconds", () => {
  it("keeps a fixed delay constant", () => {
    expect([1, 2, 10].map(attempt => backoffDelaySeconds({ strategy: "fixed", delaySeconds: 7 }, attempt))).toEqual([7, 7, 7]);
  });

  it("grows an exponential delay per failed attempt up to the ceiling", () => {
    const backoff = { strategy: "exponential", initialDelaySeconds: 2, maxDelaySeconds: 60 } as const;
    expect([1, 2, 3, 4, 5, 6, 50].map(attempt => backoffDelaySeconds(backoff, attempt))).toEqual([2, 4, 8, 16, 32, 60, 60]);
    expect(backoffDelaySeconds({ ...backoff, multiplier: 3 }, 3)).toBe(18);
  });

  it("defaults to one second, doubling, capped at five minutes", () => {
    expect(defaultQueueBackoff).toEqual({ strategy: "exponential", initialDelaySeconds: 1, maxDelaySeconds: 300, multiplier: 2 });
    expect(backoffDelaySeconds(defaultQueueBackoff, 1_000)).toBe(300);
  });

  it("reports the longest delay of a backoff", () => {
    expect(longestBackoffDelaySeconds({ strategy: "fixed", delaySeconds: 4 })).toBe(4);
    expect(longestBackoffDelaySeconds(defaultQueueBackoff)).toBe(300);
  });
});

describe("queueBackoffProblem", () => {
  it("accepts valid backoffs", () => {
    expect(queueBackoffProblem({ strategy: "fixed", delaySeconds: 0 })).toBeUndefined();
    expect(queueBackoffProblem({ strategy: "exponential", initialDelaySeconds: 1, maxDelaySeconds: 1, multiplier: 1 })).toBeUndefined();
  });

  it.each([
    [null],
    [{ strategy: "linear" }],
    [{ strategy: "fixed", delaySeconds: -1 }],
    [{ strategy: "fixed" }],
    [{ strategy: "exponential", initialDelaySeconds: 2, maxDelaySeconds: 1 }],
    [{ strategy: "exponential", initialDelaySeconds: 1 }],
    [{ strategy: "exponential", initialDelaySeconds: 1, maxDelaySeconds: 2, multiplier: 0.5 }],
    [{ strategy: "exponential", initialDelaySeconds: Number.NaN, maxDelaySeconds: 2 }]
  ])("describes the problem with %p", (value) => {
    expect(queueBackoffProblem(value)).toEqual(expect.any(String));
  });
});