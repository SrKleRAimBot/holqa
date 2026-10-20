import {
  describe,
  expect,
  it
} from "bun:test";

import {
  readControlMessage,
  readGenerationMessage,
  readOperation,
  readOperationResponse,
  readSwapVersions,
  toJson
} from "@/local/protocol";

describe("generation protocol", () => {
  it("reads well-formed messages and rejects anything else", () => {
    expect(readGenerationMessage(JSON.stringify({ type: "ready", port: 4100 }))).toEqual({ type: "ready", port: 4100 });
    expect(readGenerationMessage(JSON.stringify({ type: "ready", port: 0 }))).toBeUndefined();
    expect(readGenerationMessage(JSON.stringify({ type: "log", entry: { level: "info", message: "m", time: "t" } }))).toMatchObject({ type: "log" });
    expect(readGenerationMessage(JSON.stringify({ type: "failed", diagnostics: [{ code: "HOLQA_CONFIG_INVALID", severity: "error", message: "m" }] }))).toMatchObject({ type: "failed" });
    expect(readGenerationMessage(JSON.stringify({ type: "failed", diagnostics: [{ code: "NOT_A_CODE", severity: "error", message: "m" }] }))).toBeUndefined();
    expect(readGenerationMessage({ type: "ready", port: 1 })).toBeUndefined();
    expect(readGenerationMessage("not json")).toBeUndefined();
    expect(readControlMessage(JSON.stringify({ type: "activate" }))).toEqual({ type: "activate" });
    expect(readControlMessage(JSON.stringify({ type: "operation", id: "1", operation: { kind: "state" } }))).toEqual({ type: "operation", id: "1", operation: { kind: "state" } });
  });

  it("checks every field of an operation", () => {
    expect(readOperation({ kind: "invoke", handlerId: "a", input: { x: 1 }, attempt: 2 })).toEqual({ kind: "invoke", handlerId: "a", input: { x: 1 }, attempt: 2 });
    expect(readOperation({ kind: "invoke", handlerId: "a", attempt: 1.5 })).toBeUndefined();
    expect(readOperation({ kind: "queue.send", queueId: "q", message: null })).toEqual({ kind: "queue.send", queueId: "q", message: null });
    expect(readOperation({ kind: "queue.send", queueId: "q" })).toBeUndefined();
    expect(readOperation({ kind: "queue.redrive", queueId: "q", messageId: "m", limit: 2, dryRun: true, newOperation: false })).toEqual({ kind: "queue.redrive", queueId: "q", messageId: "m", limit: 2, dryRun: true });
    expect(readOperation({ kind: "queue.redrive", queueId: "q", limit: 0 })).toBeUndefined();
    expect(readOperation({ kind: "queue.redrive", queueId: "q", dryRun: "yes" })).toBeUndefined();
    expect(readOperation({ kind: "queue.redrive", queueId: "q", messageId: 1 })).toBeUndefined();
    expect(readOperation({ kind: "storage.put", bucketId: "b", key: "k", body: "aGk=", contentType: 3 })).toBeUndefined();
    expect(readOperation({ kind: "cron.run" })).toBeUndefined();
    expect(readOperation({ kind: "delete-everything" })).toBeUndefined();
  });

  it("reads handler replacement requests and outcomes, checking every field", () => {
    expect(readControlMessage(JSON.stringify({ type: "swap", id: "2", swap: { modules: ["src/a.ts"], shared: ["/app/infra.ts"] } }))).toEqual({ type: "swap", id: "2", swap: { modules: ["src/a.ts"], shared: ["/app/infra.ts"] } });
    expect(readControlMessage(JSON.stringify({ type: "swap", id: "2", swap: { modules: "src/a.ts", shared: [] } }))).toBeUndefined();
    const versions = [{ handlerId: "a", version: 2, active: 0, retiring: [{ version: 1, active: 1 }] }];
    expect(readGenerationMessage(JSON.stringify({ type: "swap-result", id: "2", outcome: { ok: true, version: 2, handlers: ["a"], durationMs: 12, versions } }))).toEqual({ type: "swap-result", id: "2", outcome: { ok: true, version: 2, handlers: ["a"], durationMs: 12, versions } });
    expect(readGenerationMessage(JSON.stringify({ type: "swap-result", id: "2", outcome: { ok: false, restart: true, reason: "side-effects", diagnostics: [{ code: "HOLQA_RELOAD_FAILED", severity: "info", message: "m" }] } }))).toMatchObject({ outcome: { ok: false, restart: true, reason: "side-effects" } });
    expect(readGenerationMessage(JSON.stringify({ type: "swap-result", id: "2", outcome: { ok: false, restart: true, reason: "anything", diagnostics: [] } }))).toBeUndefined();
    expect(readGenerationMessage(JSON.stringify({ type: "swap-result", id: "2", outcome: { ok: true, version: 2, handlers: ["a"], durationMs: 1, versions: [{ handlerId: "a", version: -1, active: 0, retiring: [] }] } }))).toBeUndefined();
    expect(readSwapVersions([{ handlerId: "a", version: 1, active: 0, retiring: [{ version: 0.5, active: 0 }] }])).toBeUndefined();
    expect(readOperation({ kind: "handlers" })).toEqual({ kind: "handlers" });
  });

  it("requires failed responses to carry diagnostics", () => {
    expect(readOperationResponse({ ok: true, result: { a: 1 } })).toEqual({ ok: true, result: { a: 1 } });
    expect(readOperationResponse({ ok: false, diagnostics: [] })).toBeUndefined();
  });

  it("describes values without a JSON form instead of failing", () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(toJson(undefined)).toBeNull();
    expect(toJson({ when: new Date(0) })).toEqual({ when: "1970-01-01T00:00:00.000Z" });
    expect(toJson(cyclic)).toBe("[object Object]");
    expect(toJson(10n)).toBe("10");
  });
});