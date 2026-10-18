import {
  describe,
  expect,
  it
} from "bun:test";

import {
  applicationFrame,
  devReporter,
  formatLogEntry
} from "@/output/dev-output";

describe("formatLogEntry", () => {
  it("shows the trigger, attempt, trace, cause and emitted events of an invocation", () => {
    const line = formatLogEntry({ level: "info", time: "2026-10-18T09:30:01.250Z", message: "invocation completed", handlerId: "orders.process", invocationId: "inv-2", correlationId: "7f3a9c1e-0000-4000-8000-000000000000", causationId: "inv-1", triggerKind: "queue.message", resourceId: "orders", attempt: 2, durationMs: 12.4, emitted: [{ type: "queue.message", resourceId: "emails", messageId: "m-9" }, { type: "object.created", resourceId: "receipts", key: "r/1.json" }], trigger: "cron" }, "/app");
    expect(line).toBe("09:30:01.250  info   orders.process        invocation completed  12 ms  queue.message orders  attempt 2  trace 7f3a9c1e  from inv-1  -> queue emails m-9, wrote receipts/r/1.json  trigger=cron");
  });

  it("adds the error and the first application stack frame of a failure", () => {
    const stack = "Error: boom\n    at run (/app/node_modules/lib/index.js:1:1)\n    at handler (/app/src/orders.handler.ts:12:9)\n    at /holqa/runtime.js:5:5";
    const text = formatLogEntry({ level: "error", time: "2026-10-18T09:30:01.250Z", message: "invocation failed", handlerId: "orders.process", code: "HOLQA_HANDLER_FAILED", source: "src/orders.handler.ts#process", error: { name: "Error", message: "boom", stack } }, "/app");
    expect(text.split("\n")).toEqual([
      "09:30:01.250  error  orders.process        invocation failed  HOLQA_HANDLER_FAILED",
      "      Error: boom",
      "      at src/orders.handler.ts:12:9"
    ]);
    expect(applicationFrame("Error\n    at x (file:///app/src/a.ts:3:4)", "/app")).toBe("src/a.ts:3:4");
    expect(applicationFrame("Error\n    at x (/elsewhere/a.ts:3:4)", "/app")).toBeUndefined();
  });
});

describe("devReporter", () => {
  it("writes one JSON line per event with --json", () => {
    const lines: string[] = [];
    const report = devReporter({ stdout: text => lines.push(text), stderr: text => lines.push(text) }, true, "/app");
    report({ type: "change", files: ["src/a.ts"] });
    report({ type: "dev.stopped" });
    expect(lines.map(line => JSON.parse(line) as unknown)).toEqual([{ type: "change", files: ["src/a.ts"] }, { type: "dev.stopped" }]);
  });

  it("describes reloads and repeats unchanged warnings only once", () => {
    const out: string[] = [];
    const err: string[] = [];
    const report = devReporter({ stdout: text => out.push(text), stderr: text => err.push(text) }, false, "/app");
    const warning = { code: "HOLQA_SCHEMA_RUNTIME_ONLY" as const, severity: "warning" as const, message: "w" };
    const change = { kind: "implementation" as const, resources: { added: [], removed: [], changed: [] }, handlers: { added: [], removed: [], changed: [] }, config: { added: [], removed: [], changed: [] }, contracts: [] };
    report({ type: "build", generation: 2, change, fingerprint: "sha256:x", durationMs: 40, diagnostics: [warning] });
    report({ type: "build", generation: 3, change: { ...change, kind: "resources", resources: { added: [], removed: ["queue old"], changed: [] } }, fingerprint: "sha256:y", durationMs: 41, diagnostics: [warning] });
    expect(out).toEqual([
      "build    generation 2: handler code changed; resources and contracts unchanged (40 ms)",
      "build    generation 3: resources changed; removed resource queue old (its local state is kept) (41 ms)"
    ]);
    expect(err).toHaveLength(1);
  });
});