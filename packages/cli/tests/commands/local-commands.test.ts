import type { CliHost } from "@/analysis/host";
import type { OperateOutcome } from "@/local/local-host";
import type { AppLocation } from "@/local/locations";
import type { LocalOperation } from "@/local/protocol";

import {
  compiledOutcome,
  fakeHost
} from "@test/support/fake-host";
import {
  describe,
  expect,
  it
} from "bun:test";

import { runCli } from "@/run";

/** What a fake host recorded. */
interface Recorded {
  readonly operations: Array<{ readonly location: AppLocation; readonly operation: LocalOperation }>;
}

/**
 * Creates a host whose local commands answer from a script.
 *
 * @param answer - The outcome of every operation.
 * @param files - Files the host can read, by absolute path.
 * @returns The host and what it recorded.
 */
async function localHost(answer: (operation: LocalOperation) => OperateOutcome, files: Readonly<Record<string, string>> = {}): Promise<{ readonly host: CliHost; readonly recorded: Recorded }> {
  const recorded: Recorded = { operations: [] };
  const base = fakeHost(await compiledOutcome());
  return {
    recorded,
    host: {
      ...base,
      readFile: async (path) => {
        if (files[path] === undefined)
          throw new Error("ENOENT: no such file");
        return new TextEncoder().encode(files[path]);
      },
      operate: async (location, operation) => {
        recorded.operations.push({ location, operation });
        return answer(operation);
      },
      doctor: async () => [{ name: "bun", status: "ok", message: "fine" }, { name: "state", status: "error", message: "unreadable", diagnostics: [{ code: "HOLQA_LOCAL_STATE_UNSUPPORTED", severity: "error", message: "newer" }] }]
    }
  };
}

/**
 * Runs the CLI and captures its streams.
 *
 * @param argv - The arguments.
 * @param host - The CLI host to run against.
 * @returns The exit code and output.
 */
async function run(argv: string[], host: CliHost): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> {
  let stdout = "";
  let stderr = "";
  const code = await runCli(argv, { stdout: text => stdout += `${text}\n`, stderr: text => stderr += `${text}\n` }, "1.2.3", host);
  return { code, stdout, stderr };
}

/**
 * Builds a successful outcome in the dev session.
 *
 * @param result - The operation's result.
 * @returns The outcome.
 */
const ok = (result: Record<string, never> | object): OperateOutcome => ({ target: "dev", response: { ok: true, result: result as never }, output: "", warnings: [] });

describe("local operation commands", () => {
  it("redrives dead letters with a selection, or lists them with --dry-run", async () => {
    const { host, recorded } = await localHost(operation => ok({ queueId: "orders", dryRun: operation.kind === "queue.redrive" && operation.dryRun === true, count: 1, messages: [{ messageId: "m-1", attempts: 1, lastError: { code: "HOLQA_EVENT_DEPTH_EXCEEDED", message: "too deep" } }] }));
    const dry = await run(["queue", "redrive", "orders", "--dry-run", "--limit", "5", "--message", "m-1"], host);
    expect(dry.code).toBe(0);
    expect(dry.stdout).toContain("Would redrive 1 dead-lettered message(s) of queue orders in the running dev session.");
    expect(dry.stdout).toContain("m-1  attempts 1  last error HOLQA_EVENT_DEPTH_EXCEEDED: too deep");
    const real = await run(["queue", "redrive", "orders", "--new-operation", "--json"], host);
    expect(JSON.parse(real.stdout)).toMatchObject({ target: "dev", queueId: "orders", count: 1 });
    expect(recorded.operations.map(entry => entry.operation)).toEqual([
      { kind: "queue.redrive", queueId: "orders", messageId: "m-1", limit: 5, dryRun: true },
      { kind: "queue.redrive", queueId: "orders", newOperation: true }
    ]);
    const invalid = await run(["queue", "redrive", "orders", "--limit", "0"], host);
    expect(invalid.code).toBe(2);
  });

  it("sends queue messages, resolving the application and state directory", async () => {
    const { host, recorded } = await localHost(() => ok({ queueId: "orders", messageId: "m-1" }));
    const result = await run(["queue", "send", "orders", "--data", "{\"orderId\":\"123\"}", "--delay", "30", "--app", "apps/infra.ts", "--json"], host);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ target: "dev", queueId: "orders", messageId: "m-1" });
    expect(recorded.operations).toEqual([{ location: expect.objectContaining({ appPath: "/work/shop/apps/infra.ts", stateDir: "/work/shop/apps/.holqa/local" }), operation: { kind: "queue.send", queueId: "orders", message: { orderId: "123" }, delaySeconds: 30 } }]);
  });

  it.each([
    [["queue", "send", "orders"], "--data"],
    [["queue", "send", "orders", "--data", "{oops"], "must be JSON"],
    [["queue", "send", "--data", "{}"], "<queue> is missing"],
    [["invoke", "a", "--attempt", "0"], "--attempt"],
    [["invoke", "a", "b"], "Unexpected argument"],
    [["dev", "--port", "70000"], "--port"],
    [["cron", "run"], "<schedule> is missing"]
  ])("rejects %p with exit code 2", async (argv, problem) => {
    const { host, recorded } = await localHost(() => ok({}));
    const result = await run([...argv, "--json"], host);
    expect(result.code).toBe(2);
    const parsed = JSON.parse(result.stderr) as { diagnostics: Array<{ code: string; message: string }> };
    expect(parsed.diagnostics[0]!.code).toBe("HOLQA_CLI_ARGUMENT_INVALID");
    expect(parsed.diagnostics[0]!.message).toContain(problem);
    expect(recorded.operations).toEqual([]);
  });

  it("uploads files under their name with a content type from the extension", async () => {
    const { host, recorded } = await localHost(() => ok({ bucketId: "uploads", object: { key: "sample.pdf", size: 3, contentType: "application/pdf" } }), { "/work/shop/sample.pdf": "pdf" });
    const result = await run(["storage", "put", "uploads", "./sample.pdf"], host);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Stored uploads/sample.pdf (3 bytes, application/pdf) in the running dev session.");
    expect(recorded.operations[0]!.operation).toEqual({ kind: "storage.put", bucketId: "uploads", key: "sample.pdf", contentType: "application/pdf", body: "cGRm" });
    const missing = await run(["storage", "put", "uploads", "missing.pdf", "--json"], host);
    expect(missing.code).toBe(1);
    expect(JSON.parse(missing.stderr)).toMatchObject({ diagnostics: [{ code: "HOLQA_FILE_UNREADABLE" }] });
  });

  it("exits with 1 and reports the handler's failure when an invocation fails", async () => {
    const failure = { ok: false, handlerId: "orders.process", invocationId: "i-1", correlationId: "c-1", durationMs: 1, emitted: [], failure: { code: "HOLQA_HANDLER_FAILED", message: "The handler failed.", diagnostics: [{ code: "HOLQA_HANDLER_FAILED", severity: "error", message: "The handler failed." }, { code: "HOLQA_INPUT_INVALID", severity: "error", message: "orderId: Expected a string." }] } };
    const { host } = await localHost(() => ok({ handlerId: "orders.process", outcome: failure, logs: [] }));
    const result = await run(["invoke", "orders.process", "--input", "{\"orderId\":1}", "--json"], host);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ target: "dev", outcome: { ok: false } });
    expect(JSON.parse(result.stderr)).toMatchObject({ diagnostics: [{ code: "HOLQA_HANDLER_FAILED", details: { invocationId: "i-1", correlationId: "c-1" } }, { code: "HOLQA_INPUT_INVALID" }] });
  });

  it("reports operations that fail as diagnostics", async () => {
    const { host } = await localHost(() => ({ target: "standalone", response: { ok: false, diagnostics: [{ code: "HOLQA_RESOURCE_NOT_FOUND", severity: "error", message: "No queue \"nope\"." }] }, output: "", warnings: [] }));
    const result = await run(["queue", "send", "nope", "--data", "{}"], host);
    expect(result).toMatchObject({ code: 1, stderr: "error HOLQA_RESOURCE_NOT_FOUND: No queue \"nope\".\n" });
  });

  it("fails a scheduled run that failed, and summarizes local state", async () => {
    const { host } = await localHost(operation => operation.kind === "cron.run"
      ? ok({ scheduleId: "cleanup", run: { runId: "r-1", status: "failed", code: "HOLQA_HANDLER_FAILED", message: "boom" }, logs: [] })
      : ok({ application: "shop", queues: [{ id: "orders", counts: { "ready": 1, "dead-lettered": 1 }, messages: [{ messageId: "m-1", state: "dead-lettered", attempts: 3, lastError: { code: "HOLQA_HANDLER_FAILED", message: "boom" } }, { messageId: "m-2", state: "ready", attempts: 0 }] }], buckets: [], schedules: [] }));
    const cron = await run(["cron", "run", "cleanup", "--json"], host);
    expect(cron.code).toBe(1);
    expect(JSON.parse(cron.stderr)).toMatchObject({ diagnostics: [{ code: "HOLQA_HANDLER_FAILED", details: { runId: "r-1" } }] });
    const state = await run(["state"], host);
    expect(state.code).toBe(0);
    expect(state.stdout).toContain("queue orders: 1 ready, 1 dead-lettered");
    expect(state.stdout).toContain("m-1  dead-lettered  attempts 3  last error HOLQA_HANDLER_FAILED: boom");
    expect(state.stdout).toContain("m-2  ready          attempts 0\n");
  });
});

describe("holqa doctor", () => {
  it("prints every check and exits with 1 when one failed", async () => {
    const { host } = await localHost(() => ok({}));
    const text = await run(["doctor"], host);
    expect(text.code).toBe(1);
    expect(text.stdout).toContain("ok       bun             fine");
    expect(text.stdout).toContain("error    state           unreadable");
    const json = await run(["doctor", "--json"], host);
    expect(JSON.parse(json.stdout)).toMatchObject({ checks: [{ name: "bun" }, { name: "state", status: "error" }] });
    expect(JSON.parse(json.stderr)).toMatchObject({ diagnostics: [{ code: "HOLQA_DOCTOR_CHECK_FAILED" }, { code: "HOLQA_LOCAL_STATE_UNSUPPORTED" }] });
  });
});

describe("holqa dev options", () => {
  it("passes --no-hot and --no-dashboard to the dev session, and defaults both on", async () => {
    const requests: Array<{ readonly hot?: boolean; readonly dashboard?: boolean; readonly watch: boolean }> = [];
    const base = fakeHost(await compiledOutcome());
    const host: CliHost = {
      ...base,
      dev: async (request) => {
        requests.push(request);
        return { ok: true, value: undefined };
      }
    };
    expect((await run(["dev", "--no-hot", "--no-dashboard"], host)).code).toBe(0);
    expect((await run(["dev"], host)).code).toBe(0);
    expect(requests.map(({ hot, dashboard, watch }) => ({ hot, dashboard, watch }))).toEqual([{ hot: false, dashboard: false, watch: true }, { hot: true, dashboard: true, watch: true }]);
    expect((await run(["dev", "--no-hot=yes"], host)).code).toBe(2);
  });
});