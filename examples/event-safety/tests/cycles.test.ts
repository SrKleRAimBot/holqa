import {
  dirname,
  join
} from "node:path";
import {
  describe,
  expect,
  it,
  setDefaultTimeout
} from "bun:test";

// Every test runs the built CLI, which spawns an analysis process; allow for slow machines.
setDefaultTimeout(60_000);

/** This example's directory. */
const example = join(import.meta.dir, "..");

/** The built `holqa` binary, through the CLI package's public files. */
const bin = join(dirname(Bun.resolveSync("@holqa/cli/package.json", example)), "dist", "bin.js");

/**
 * Runs the built CLI in this example's directory.
 *
 * @param args - The arguments.
 * @returns The exit code and output.
 */
function holqa(...args: string[]): { readonly code: number; readonly stdout: string; readonly stderr: string } {
  const result = Bun.spawnSync(["bun", bin, ...args], { cwd: example });
  return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

describe("holqa inspect --cycles", () => {
  it("reports the indirect reminder cycle, allows the justified shipment cycle and sees that thumbnails cannot loop", () => {
    const result = holqa("inspect", "--cycles", "--json", "--app", "app/infra.ts");
    expect(result.code).toBe(0);
    const document = JSON.parse(result.stdout) as {
      readonly cycles: readonly unknown[];
      readonly diagnostics: ReadonlyArray<{ readonly code: string }>;
      readonly events: { readonly nodes: ReadonlyArray<{ readonly type: string; readonly id: string; readonly coverage?: string }>; readonly edges: readonly unknown[]; readonly unresolved: readonly unknown[] };
    };
    expect(document.cycles).toMatchObject([
      { status: "reported", certainty: "known", handlers: ["followups.send", "reminders.send"], path: [{ handler: "followups.send", call: "reminders.send()" }, { handler: "reminders.send", call: "resources.followups.send()" }] },
      { status: "allowed", certainty: "known", handlers: ["shipments.fulfil"], allowedBy: [{ handler: "shipments.fulfil", justification: "Each check increments checks; after maxStockChecks the shipment is given up." }] }
    ]);
    expect(document.diagnostics.filter(diagnostic => diagnostic.code === "HOLQA_EVENT_CYCLE")).toMatchObject([{ severity: "warning", location: { file: "app/src/reminders.handler.ts" } }]);
    expect(document.events.edges).toContainEqual(expect.objectContaining({ from: "handler:images.thumbnail", to: "resource:images", operation: "put", certainty: "known", keyPrefix: "thumbnails/", keyExact: false }));
    expect(document.events.nodes.filter(node => node.type === "handler").map(node => [node.id, node.coverage])).toEqual([
      ["followups.send", "complete"],
      ["images.thumbnail", "complete"],
      ["payments.charge", "complete"],
      ["reminders.send", "complete"],
      ["shipments.fulfil", "complete"]
    ]);
    expect(document.events.unresolved).toEqual([]);
  });

  it("prints a readable report and keeps the warning on standard error", () => {
    const result = holqa("inspect", "--cycles", "--app", "app/infra.ts");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("warning  known      followups.send → reminders.send() → reminders.send → resources.followups.send() → followups.send");
    expect(result.stdout).toContain("allowed by shipments.fulfil: Each check increments checks");
    expect(result.stdout).toContain("put \"images\"  known  resources.images.put()  app/src/images.handler.ts:");
    expect(result.stderr).toContain("warning HOLQA_EVENT_CYCLE: Event cycle: followups.send → reminders.send()");
  });

  it("builds the manifest despite the warning: cycles are findings, not errors", () => {
    const result = holqa("inspect", "--json", "--app", "app/infra.ts");
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ manifest: { application: { name: "event-safety" } } });
  });
});