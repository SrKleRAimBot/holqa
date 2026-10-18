import type { Manifest } from "@holqa/compiler";

import { compileApplication } from "@holqa/compiler";
import {
  application,
  consumer,
  queue,
  secret,
  text
} from "@test/support/descriptors";
import {
  describe,
  expect,
  it
} from "bun:test";

import { classifyChange } from "@/dev/classify";

/**
 * Compiles a fixture application.
 *
 * @param resources - The queues to declare.
 * @param handlers - The consumers to register, as `[handlerId, queueId]`.
 * @param secrets - The secrets to declare.
 * @returns The compiled manifest.
 * @throws {Error} When the fixture does not compile.
 */
async function manifestOf(resources: readonly string[], handlers: ReadonlyArray<readonly [string, string]>, secrets: readonly string[] = []): Promise<Manifest> {
  const result = await compileApplication({
    app: application("shop", resources.map(id => queue(id)), secrets.map(name => secret(name))),
    appModule: "infra.ts",
    modules: [{ path: "src/a.handler.ts", exports: Object.fromEntries(handlers.map(([handlerId, queueId]) => [handlerId.replace(".", "_"), consumer(handlerId, queueId)])) }],
    runtime: "bun"
  });
  if (!result.ok)
    throw new Error(JSON.stringify(result.diagnostics));
  return result.manifest;
}

describe("classifyChange", () => {
  it("reports the first build with everything added", async () => {
    const change = classifyChange(undefined, await manifestOf(["orders"], [["orders.process", "orders"]]));
    expect(change).toMatchObject({ kind: "initial", resources: { added: ["queue orders"] }, handlers: { added: ["orders.process"] } });
  });

  it("treats an unchanged manifest as an implementation change, which keeps the resource graph", async () => {
    const manifest = await manifestOf(["orders"], [["orders.process", "orders"]]);
    expect(classifyChange(manifest, await manifestOf(["orders"], [["orders.process", "orders"]]))).toEqual({
      kind: "implementation",
      resources: { added: [], removed: [], changed: [] },
      handlers: { added: [], removed: [], changed: [] },
      config: { added: [], removed: [], changed: [] },
      contracts: []
    });
  });

  it("distinguishes handler changes from resource and configuration changes", async () => {
    const before = await manifestOf(["orders", "refunds"], [["orders.process", "orders"]]);
    const handlers = classifyChange(before, await manifestOf(["orders", "refunds"], [["orders.process", "orders"], ["refunds.process", "refunds"]]));
    expect(handlers).toMatchObject({ kind: "handlers", handlers: { added: ["refunds.process"] }, resources: { added: [], removed: [] } });
    const resources = classifyChange(before, await manifestOf(["orders"], [["orders.process", "orders"]]));
    expect(resources).toMatchObject({ kind: "resources", resources: { removed: ["queue refunds"] } });
    const config = classifyChange(before, await manifestOf(["orders", "refunds"], [["orders.process", "orders"]], ["API_TOKEN"]));
    expect(config).toMatchObject({ kind: "resources", config: { added: ["API_TOKEN"] } });
  });

  it("reports contract changes of queue messages with the compatibility checker", async () => {
    const before = await manifestOf(["orders"], [["orders.process", "orders"]]);
    const numbered = { ...queue("orders"), schemas: { message: { "~standard": { ...text["~standard"], jsonSchema: { input: () => ({ type: "number" }), output: () => ({ type: "number" }) } } } } };
    const result = await compileApplication({
      app: application("shop", [numbered as never]),
      appModule: "infra.ts",
      modules: [{ path: "src/a.handler.ts", exports: { consumer: { "~holqa": { ...consumer("orders.process", "orders")["~holqa"], schemas: { message: numbered.schemas.message } } } } }],
      runtime: "bun"
    });
    if (!result.ok)
      throw new Error(JSON.stringify(result.diagnostics));
    const change = classifyChange(before, result.manifest);
    expect(change.kind).toBe("resources");
    expect(change.contracts.map(diagnostic => diagnostic.code)).toContain("HOLQA_SCHEMA_CHANGE_BREAKING");
  });
});