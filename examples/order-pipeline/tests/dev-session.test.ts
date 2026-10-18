import type { Subprocess } from "bun";

import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import {
  dirname,
  join
} from "node:path";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
  setDefaultTimeout
} from "bun:test";

// Every step goes through real processes and the file watcher; allow for slow machines.
setDefaultTimeout(60_000);

/** This example's directory. */
const example = join(import.meta.dir, "..");

/** The built `holqa` binary, through the CLI package's public files. */
const bin = join(dirname(Bun.resolveSync("@holqa/cli/package.json", example)), "dist", "bin.js");

/** A copy of the application that the test edits; inside the example so its packages resolve. */
let workspace: string;

/** The running `holqa dev --json`. */
let dev: Subprocess<"ignore", "pipe", "pipe">;

/** One JSON line of `holqa dev --json`, with the fields this test reads. */
interface DevLine {
  readonly type: string;
  readonly url?: unknown;
  readonly entry?: Readonly<Record<string, unknown>>;
  readonly summary?: unknown;
  readonly change?: unknown;
  readonly diagnostics?: unknown;
  readonly serving?: unknown;
  readonly pid?: unknown;
}

/** Every event it printed, parsed. */
const events: DevLine[] = [];

/** The session's URL. */
let url: string;

/**
 * Waits for an event that satisfies a predicate.
 *
 * @param predicate - The condition.
 * @param since - Only events from this index on.
 * @returns The event.
 * @throws {Error} After 30 seconds.
 */
async function waitFor(predicate: (event: (typeof events)[number]) => boolean, since = 0): Promise<(typeof events)[number]> {
  for (let round = 0; round < 3_000; round += 1) {
    const found = events.slice(since).find(predicate);
    if (found !== undefined)
      return found;
    await Bun.sleep(10);
  }
  throw new Error(`No matching event; the last ones were ${JSON.stringify(events.slice(-5))}`);
}

/**
 * Waits for a log entry of the session.
 *
 * @param match - Fields the entry must have.
 * @param since - Only events from this index on.
 * @returns The entry.
 */
async function waitForLog(match: Readonly<Record<string, unknown>>, since = 0): Promise<Record<string, unknown>> {
  const event = await waitFor(candidate => candidate.type === "log" && Object.entries(match).every(([key, value]) => candidate.entry?.[key] === value), since);
  return event.entry ?? {};
}

/**
 * Runs a CLI command against the session's application.
 *
 * @param args - The arguments after `holqa`.
 * @returns The exit code and the parsed JSON output.
 */
async function holqa(...args: string[]): Promise<{ readonly code: number; readonly output: Record<string, unknown> | undefined; readonly stderr: string }> {
  const child = Bun.spawn(["bun", bin, ...args, "--app", "app/infra.ts", "--json"], { cwd: workspace, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { code, output: stdout.trim() === "" ? undefined : JSON.parse(stdout) as Record<string, unknown>, stderr };
}

/**
 * Rewrites a file of the copied application.
 *
 * @param path - The path relative to the application.
 * @param edit - Produces the new contents.
 */
function edit(path: string, edit: (source: string) => string): void {
  const file = join(workspace, "app", path);
  writeFileSync(file, edit(readFileSync(file, "utf8")));
}

beforeAll(async () => {
  mkdirSync(join(example, ".tmp"), { recursive: true });
  workspace = mkdtempSync(join(example, ".tmp", "dev-"));
  cpSync(join(example, "app"), join(workspace, "app"), { recursive: true });
  writeFileSync(join(workspace, "tsconfig.json"), JSON.stringify({ compilerOptions: { paths: { "@/*": ["./*"] } } }));
  dev = Bun.spawn(["bun", bin, "dev", "--app", "app/infra.ts", "--port", "0", "--json"], { cwd: workspace, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  void (async () => {
    let buffered = "";
    for await (const chunk of dev.stdout) {
      buffered += new TextDecoder().decode(chunk);
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines.filter(text => text.trim() !== ""))
        events.push(JSON.parse(line) as DevLine);
    }
  })();
  url = (await waitFor(event => event.type === "dev.listening")).url as string;
  await waitFor(event => event.type === "generation.ready");
});

afterAll(async () => {
  try {
    dev?.kill("SIGKILL");
    await dev?.exited;
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

// The steps build on each other: one session runs through the whole suite, as a developer's would.
describe("holqa dev on the order pipeline", () => {
  it("runs the application without infrastructure credentials and reports its graph", async () => {
    const ready = await waitFor(event => event.type === "generation.ready");
    const summary = ready.summary as { readonly handlers: ReadonlyArray<{ readonly id: string; readonly endpoint?: string }> };
    expect(summary.handlers.map(handler => handler.endpoint ?? handler.id)).toEqual(["cleanup.run", "GET /api/orders/:orderId", "POST /api/orders", "orders.process", "uploads.received"]);
    const since = events.length;
    const response = await fetch(new URL("/api/orders", url), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ orderId: "123", totalCents: 990 }) });
    expect(response.status).toBe(202);
    const { correlationId } = await waitForLog({ handlerId: "orders.process", message: "invocation completed" }, since);
    expect(correlationId).toBe(response.headers.get("x-correlation-id"));
    expect((await fetch(new URL("/api/orders/123", url))).status).toBe(200);
  });

  it("runs the CLI's operations in the session, with JSON output and exit codes", async () => {
    const invoked = await holqa("invoke", "orders.process", "--input", "{\"orderId\":\"cli-1\"}");
    expect(invoked).toMatchObject({ code: 0, output: { target: "dev", outcome: { ok: true, emitted: [{ type: "object.created", key: "receipts/cli-1.json" }] } } });
    const sent = await holqa("queue", "send", "orders", "--data", "{\"orderId\":\"cli-2\"}");
    expect(sent).toMatchObject({ code: 0, output: { target: "dev", queueId: "orders" } });
    writeFileSync(join(workspace, "sample.pdf"), "%PDF-1.7 sample");
    const since = events.length;
    const stored = await holqa("storage", "put", "uploads", "./sample.pdf");
    expect(stored).toMatchObject({ code: 0, output: { target: "dev", object: { key: "sample.pdf", contentType: "application/pdf" } } });
    await waitForLog({ handlerId: "uploads.received", message: "invocation completed" }, since);
    const run = await holqa("cron", "run", "cleanup");
    expect(run).toMatchObject({ code: 0, output: { run: { status: "succeeded", trigger: "manual" } } });
    const state = await holqa("state");
    expect(state.output).toMatchObject({ target: "dev", queues: [{ id: "orders" }], schedules: [{ id: "cleanup", runs: [expect.objectContaining({ trigger: "manual" })] }] });
    const invalid = await holqa("queue", "send", "orders", "--data", "{\"orderId\":1}");
    expect(invalid.code).toBe(1);
    expect(JSON.parse(invalid.stderr)).toMatchObject({ diagnostics: [{ code: "HOLQA_INPUT_INVALID" }] });
    const doctor = await holqa("doctor");
    expect(doctor.code).toBe(0);
    expect(doctor.output).toMatchObject({ checks: expect.arrayContaining([expect.objectContaining({ name: "session", status: "ok" })]) });
  });

  it("applies a changed handler to the next execution, keeping the queued and stored state", async () => {
    const since = events.length;
    edit("src/orders.handler.ts", source => source.replace("log.info(\"order processed\"", "log.info(\"order processed (v2)\""));
    // File systems may report one save as several events; match the build by content, not by position.
    const build = await waitFor(event => event.type === "build", since);
    expect(build.change).toMatchObject({ kind: "implementation" });
    await waitFor(event => event.type === "generation.ready", events.indexOf(build));
    expect((await fetch(new URL("/api/orders/123", url))).status).toBe(200);
    const after = events.length;
    await fetch(new URL("/api/orders", url), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ orderId: "456" }) });
    await waitForLog({ message: "order processed (v2)" }, after);
  });

  it("reports contract changes, and keeps serving when a change breaks the application", async () => {
    let since = events.length;
    edit("src/contracts.ts", source => source.replace("totalCents: z.number().int().min(0).optional()", "totalCents: z.number().int().min(0)"));
    const build = await waitFor(event => event.type === "build.failed" || (event.type === "build" && JSON.stringify(event.change).includes("HOLQA_SCHEMA_CHANGE_BREAKING")), since);
    expect(build.type).toBe("build");
    await waitFor(event => event.type === "generation.ready", events.indexOf(build));

    since = events.length;
    edit("src/orders.handler.ts", source => `${source}\nexport const broken = ;\n`);
    const failed = await waitFor(event => event.type === "build.failed", since);
    expect((failed.diagnostics as Array<{ readonly code: string }>)[0]!.code).toBe("HOLQA_RELOAD_FAILED");
    expect(failed.serving).toEqual(expect.any(Number));
    expect((await fetch(new URL("/api/orders/123", url))).status).toBe(200);
  });

  it("stops cleanly on SIGTERM, leaving no session or generation process behind", async () => {
    const pid = (events.filter(event => event.type === "generation.ready").at(-1)!.pid) as number;
    dev.kill("SIGTERM");
    expect(await dev.exited).toBe(0);
    await waitFor(event => event.type === "dev.stopped");
    expect(existsSync(join(workspace, "app", ".holqa", "dev", "session.json"))).toBe(false);
    expect(() => process.kill(pid, 0)).toThrow();
  });
});