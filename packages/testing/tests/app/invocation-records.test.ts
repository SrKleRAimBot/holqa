import type { LogEntry } from "@holqa/runtime-bun";

import {
  describe,
  expect,
  it
} from "bun:test";

import { invocationRecords } from "@/app/invocation-records";

describe("invocationRecords", () => {
  it("reads finished invocations from log entries and ignores everything else", () => {
    const entries: LogEntry[] = [
      { level: "info", time: "t", message: "runtime started" },
      { level: "info", time: "t", message: "invocation completed", handlerId: "a", invocationId: "i-1", correlationId: "c", triggerKind: "http.route", resourceId: "api", outcome: "ok", durationMs: 2, emitted: [{ type: "queue.message", resourceId: "q", messageId: "m" }, { type: "bogus" }] },
      { level: "error", time: "t", message: "invocation failed", handlerId: "b", invocationId: "i-2", correlationId: "c", causationId: "i-1", rootId: "i-1", depth: 1, attempt: 2, code: "HOLQA_HANDLER_FAILED", blocked: "HOLQA_EVENT_DEPTH_EXCEEDED", durationMs: 1 }
    ];
    expect(invocationRecords(entries)).toEqual([
      { handlerId: "a", invocationId: "i-1", correlationId: "c", rootId: "i-1", depth: 0, trigger: "http.route", resourceId: "api", outcome: "ok", emitted: [{ type: "queue.message", resourceId: "q", messageId: "m" }], durationMs: 2 },
      { handlerId: "b", invocationId: "i-2", correlationId: "c", causationId: "i-1", rootId: "i-1", depth: 1, outcome: "failed", code: "HOLQA_HANDLER_FAILED", attempt: 2, emitted: [], blocked: "HOLQA_EVENT_DEPTH_EXCEEDED", durationMs: 1 }
    ]);
  });
});