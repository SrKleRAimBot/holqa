import {
  describe,
  expect,
  it,
  spyOn
} from "bun:test";

import {
  describeError,
  jsonLineSink,
  StructuredLogger
} from "@/logging/log";

describe("StructuredLogger", () => {
  it("writes context and fields next to level, time and message, which fields cannot replace", () => {
    const lines: string[] = [];
    const logger = new StructuredLogger(jsonLineSink(line => lines.push(line)), { application: "shop" }, () => new Date(0)).child({ invocationId: "inv-1" });
    logger.forHandler().warn("slow", { durationMs: 12, message: "spoofed", time: "never" });
    expect(lines).toEqual([`${JSON.stringify({ level: "warn", time: "1970-01-01T00:00:00.000Z", message: "slow", application: "shop", invocationId: "inv-1", durationMs: 12 })}\n`]);
  });

  it("reports a failing sink on standard error instead of failing the caller", () => {
    const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      new StructuredLogger(() => {
        throw new Error("disk full");
      }).write("info", "hello");
      expect(String(stderr.mock.calls[0]?.[0])).toContain("disk full");
    } finally {
      stderr.mockRestore();
    }
  });
});

describe("describeError", () => {
  it("describes errors, their diagnostics and causes", () => {
    const error = new Error("outer", { cause: Object.assign(new Error("inner"), { diagnostics: [{ code: "HOLQA_INPUT_INVALID", message: "Bad." }] }) });
    const described = describeError(error);
    expect(described).toMatchObject({ name: "Error", message: "outer", cause: { message: "inner", diagnostics: [{ code: "HOLQA_INPUT_INVALID", message: "Bad." }] } });
    expect(describeError(42)).toEqual({ value: "42" });
  });
});