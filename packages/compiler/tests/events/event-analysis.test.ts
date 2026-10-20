import type { CompileApplicationSuccess } from "@/index";

import {
  objectCreatedHandler,
  queueConsumer,
  routeHandler
} from "@test/support/application";
import {
  bucketHandle,
  eventInput,
  message,
  queueHandle,
  withEvents
} from "@test/support/events";
import {
  describe,
  expect,
  it
} from "bun:test";

import {
  canonicalJsonStringify,
  compileApplication,
  validateEventAnalysis
} from "@/index";

/**
 * Writes a template literal substitution as source text.
 *
 * @param expression - The substituted expression.
 * @returns `${expression}`, written without a template string in this test's own source.
 */
function substitution(expression: string): string {
  return ["$", "{", expression, "}"].join("");
}

/**
 * Compiles an event fixture and asserts success.
 *
 * @param fixture - Resources, handler modules and their sources.
 * @returns The successful result.
 */
async function compile(fixture: Parameters<typeof eventInput>[0]): Promise<CompileApplicationSuccess> {
  const result = await compileApplication(eventInput(fixture));
  if (!result.ok)
    throw new Error(JSON.stringify(result.diagnostics, undefined, 2));
  return result;
}

describe("event cycle analysis", () => {
  it("warns about a queue consumer that sends to its own queue, with the path and location", async () => {
    const orders = queueHandle("orders");
    const result = await compile({
      resources: { orders },
      modules: [{
        path: "src/orders.ts",
        exports: { processOrder: queueConsumer("orders.process", "orders", message) },
        source: [
          "import { resources } from \"@/infra\";",
          "export const processOrder = resources.orders.consume({",
          "  id: \"orders.process\",",
          "  handler: async ({ message }) => {",
          "    await resources.orders.send({ ...message, retry: true });",
          "  }",
          "});"
        ].join("\n")
      }]
    });
    const cycles = result.diagnostics.filter(diagnostic => diagnostic.code === "HOLQA_EVENT_CYCLE");
    expect(cycles).toHaveLength(1);
    expect(cycles[0]).toMatchObject({
      severity: "warning",
      location: { file: "src/orders.ts", line: 5, column: 11 },
      details: { certainty: "known", handlers: ["orders.process"], path: [{ handler: "orders.process", resource: "orders", operation: "send", certainty: "known", call: "resources.orders.send()" }] }
    });
    expect(cycles[0]!.message).toContain("orders.process → resources.orders.send() → orders.process");
    expect(result.events.cycles).toMatchObject([{ status: "reported", certainty: "known", handlers: ["orders.process"] }]);
    expect(result.events.graph.edges).toContainEqual(expect.objectContaining({ from: "handler:orders.process", to: "resource:orders", relation: "publishes", certainty: "known", origin: "analysis" }));
    expect(result.events.graph.nodes).toContainEqual(expect.objectContaining({ key: "handler:orders.process", coverage: "complete" }));
  });

  it("detects an indirect cycle A → B → A through aliases and destructuring", async () => {
    const a = queueHandle("queue-a");
    const b = queueHandle("queue-b");
    const result = await compile({
      resources: { a, b },
      modules: [
        {
          path: "src/a.ts",
          exports: { onA: queueConsumer("a.process", "queue-a", message) },
          source: "import { resources } from \"../infra\";\nconst next = resources.b;\nexport const onA = resources.a.consume({ id: \"a.process\", handler: async () => { await next.send({}); } });"
        },
        {
          path: "src/b.ts",
          exports: { onB: queueConsumer("b.process", "queue-b", message) },
          source: "import { resources as r } from \"../infra\";\nconst { a } = r;\nexport const onB = r.b.consume({ id: \"b.process\", handler: async () => { await a.send({}); } });"
        }
      ]
    });
    const [cycle] = result.diagnostics.filter(diagnostic => diagnostic.code === "HOLQA_EVENT_CYCLE");
    expect(cycle).toMatchObject({ severity: "warning", details: { certainty: "known", handlers: ["a.process", "b.process"] } });
    expect(cycle!.message).toContain("a.process → next.send() → b.process → a.send() → a.process");
  });

  it("permits a cycle a handler justifies without hiding other cycles", async () => {
    const orders = queueHandle("orders");
    const audit = queueHandle("audit");
    const justification = "Requeues until the order reaches a terminal state.";
    const result = await compile({
      resources: { orders, audit },
      modules: [{
        path: "src/handlers.ts",
        exports: {
          processOrder: withEvents(queueConsumer("orders.process", "orders", message), { cycle: { justification }, maxDepth: 5 }),
          audit: queueConsumer("audit.process", "audit", message)
        },
        source: [
          "import { resources } from \"@/infra\";",
          "export const processOrder = resources.orders.consume({ id: \"orders.process\", handler: async ({ message }) => {",
          "  if (message.status !== \"done\") await resources.orders.send(message);",
          "} });",
          "export const audit = resources.audit.consume({ id: \"audit.process\", handler: async () => { await resources.audit.send({}); } });"
        ].join("\n")
      }]
    });
    const reported = result.diagnostics.filter(diagnostic => diagnostic.code === "HOLQA_EVENT_CYCLE");
    expect(reported).toHaveLength(1);
    expect(reported).toMatchObject([{ details: { handlers: ["audit.process"] } }]);
    expect(result.events.cycles.map(cycle => [cycle.status, cycle.handlers])).toEqual([["reported", ["audit.process"]], ["allowed", ["orders.process"]]]);
    expect(result.events.cycles[1]!.allowedBy).toEqual([{ handler: "orders.process", justification }]);
    expect(result.events.graph.nodes).toContainEqual(expect.objectContaining({ key: "handler:orders.process", cycle: { justification }, maxDepth: 5 }));
  });

  it("reports a cycle through a helper function as potential information", async () => {
    const orders = queueHandle("orders");
    const result = await compile({
      resources: { orders },
      modules: [{
        path: "src/orders.ts",
        exports: { processOrder: queueConsumer("orders.process", "orders", message) },
        source: [
          "import { resources } from \"@/infra\";",
          "import { requeue } from \"./lib/requeue\";",
          "export const processOrder = resources.orders.consume({ id: \"orders.process\", handler: processOrderMessage });",
          "async function processOrderMessage(context) { await requeue(context.message); }"
        ].join("\n")
      }],
      sources: { "src/lib/requeue.ts": "import { resources } from \"../../infra\";\nexport async function requeue(message) {\n  await resources.orders.send(message);\n}" }
    });
    const [cycle] = result.diagnostics.filter(diagnostic => diagnostic.code === "HOLQA_EVENT_CYCLE");
    expect(cycle).toMatchObject({ severity: "info", location: { file: "src/lib/requeue.ts", line: 3 }, details: { certainty: "potential" } });
    expect(result.events.graph.edges).toContainEqual(expect.objectContaining({ from: "handler:orders.process", certainty: "potential", via: ["src/lib/requeue.ts#requeue"] }));
  });

  it("compares object keys with handler prefixes", async () => {
    const files = bucketHandle("files");
    /**
     * Compiles a handler on `incoming/` that writes one key expression.
     *
     * @param key - The key argument as written.
     * @returns The cycle diagnostics' severities.
     */
    const severities = async (key: string): Promise<string[]> => {
      const result = await compile({
        resources: { files },
        modules: [{
          path: "src/files.ts",
          exports: { onFile: objectCreatedHandler("files.created", "files", "incoming/") },
          source: `import { resources } from "@/infra";\nexport const onFile = resources.files.onObjectCreated({ id: "files.created", prefix: "incoming/", handler: async ({ object }) => { await resources.files.put(${key}, "x"); } });`
        }]
      });
      return result.diagnostics.filter(diagnostic => diagnostic.code === "HOLQA_EVENT_CYCLE").map(diagnostic => diagnostic.severity);
    };
    expect(await severities(`\`processed/${substitution("object.key")}\``)).toEqual([]);
    expect(await severities("\"processed/a.txt\"")).toEqual([]);
    expect(await severities(`\`incoming/${substitution("object.key")}.copy\``)).toEqual(["warning"]);
    expect(await severities(`\`in${substitution("object.key")}\``)).toEqual(["info"]);
    expect(await severities("object.key + \".copy\"")).toEqual(["info"]);
  });

  it("uses declared publications where code cannot be followed, and lists unresolved calls", async () => {
    const orders = queueHandle("orders");
    const result = await compile({
      resources: { orders },
      modules: [{
        path: "src/orders.ts",
        exports: { processOrder: withEvents(queueConsumer("orders.process", "orders", message), { publishes: [{ kind: "queue", id: "orders" }] }) },
        source: "import { resources } from \"@/infra\";\nimport { client } from \"some-library\";\nexport const processOrder = resources.orders.consume({ id: \"orders.process\", handler: async () => { await client.send({}); } });"
      }]
    });
    expect(result.diagnostics.filter(diagnostic => diagnostic.code === "HOLQA_EVENT_CYCLE")).toMatchObject([{ severity: "warning", details: { path: [{ operation: "send", certainty: "known" }] } }]);
    expect(result.diagnostics.find(diagnostic => diagnostic.code === "HOLQA_EVENT_CYCLE")!.message).toContain("send on \"orders\" (declared)");
    expect(result.events.graph.unresolved).toMatchObject([{ handler: "orders.process", operation: "send", certainty: "unknown", call: "client.send()" }]);
    expect(result.events.graph.nodes).toContainEqual(expect.objectContaining({ key: "handler:orders.process", coverage: "partial" }));
  });

  it("ignores calls on values that are not handles and records handles passed to functions as potential", async () => {
    const orders = queueHandle("orders");
    const audit = queueHandle("audit");
    const result = await compile({
      resources: { orders, audit },
      modules: [{
        path: "src/orders.ts",
        exports: { processOrder: queueConsumer("orders.process", "orders", message) },
        source: "import { resources } from \"@/infra\";\nimport { forward } from \"some-library\";\nconst seen = new Map();\nexport const processOrder = resources.orders.consume({ id: \"orders.process\", handler: async ({ message }) => { seen.delete(message.id); await forward(resources.orders, message); } });"
      }]
    });
    expect(result.events.graph.unresolved).toEqual([]);
    expect(result.events.graph.edges).toContainEqual(expect.objectContaining({ from: "handler:orders.process", to: "resource:orders", certainty: "potential", call: "resources.orders passed to a function" }));
    expect(result.diagnostics.find(diagnostic => diagnostic.code === "HOLQA_EVENT_CYCLE")?.severity).toBe("info");
  });

  it("includes HTTP handlers as publishers that cannot be part of a cycle", async () => {
    const orders = queueHandle("orders");
    const api = { resource: { protocol: 1, type: "resource", kind: "http.api", id: "api", config: { basePath: "/api" }, requirements: {}, schemas: {} }, handle: undefined } as never;
    const result = await compile({
      resources: { orders, api },
      modules: [{
        path: "src/api.ts",
        exports: { place: routeHandler("orders.place", "api", "POST", "/orders") },
        source: "import { resources } from \"@/infra\";\nexport const place = resources.api.route({ method: \"POST\", path: \"/orders\", id: \"orders.place\", handler: async ({ reply }) => { await resources.orders.send({}); return reply(202, {}); } });"
      }]
    });
    expect(result.events.cycles).toEqual([]);
    expect(result.events.graph.edges).toContainEqual(expect.objectContaining({ from: "handler:orders.place", to: "resource:orders", certainty: "known" }));
    expect(result.events.graph.edges).toContainEqual({ from: "resource:api", to: "handler:orders.place", relation: "consumes", event: "http.request" });
  });

  it("marks handlers without source as unavailable and still uses their declared publications", async () => {
    const orders = queueHandle("orders");
    const input = eventInput({ resources: { orders }, modules: [{ path: "src/orders.ts", exports: { processOrder: withEvents(queueConsumer("orders.process", "orders", message), { publishes: [{ kind: "queue", id: "orders" }] }) }, source: "" }] });
    const result = await compileApplication({ ...input, sources: {} });
    if (!result.ok)
      throw new Error("Expected compilation to succeed.");
    expect(result.events.graph.nodes).toContainEqual(expect.objectContaining({ key: "handler:orders.process", coverage: "unavailable" }));
    expect(result.events.cycles).toMatchObject([{ status: "reported", certainty: "known" }]);
  });

  it("rejects malformed policies and declared publications of undeclared resources", async () => {
    const orders = queueHandle("orders");
    const input = eventInput({
      resources: { orders },
      modules: [{
        path: "src/orders.ts",
        exports: {
          a: withEvents(queueConsumer("a", "orders", message), { maxDepth: 0 }),
          b: withEvents(queueConsumer("b", "orders", message), { publishes: [{ kind: "queue", id: "missing" }] })
        },
        source: ""
      }]
    });
    const result = await compileApplication(input);
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map(diagnostic => diagnostic.code)).toEqual(expect.arrayContaining(["HOLQA_DECLARATION_INVALID", "HOLQA_RESOURCE_NOT_FOUND"]));
  });

  it("is deterministic: module order does not change the analysis, and it serializes canonically", async () => {
    const a = queueHandle("queue-a");
    const b = queueHandle("queue-b");
    const modules = [
      { path: "src/a.ts", exports: { onA: queueConsumer("a.process", "queue-a", message) }, source: "import { resources } from \"@/infra\";\nexport const onA = resources.a.consume({ id: \"a.process\", handler: async () => { await resources.b.send({}); } });" },
      { path: "src/b.ts", exports: { onB: queueConsumer("b.process", "queue-b", message) }, source: "import { resources } from \"@/infra\";\nexport const onB = resources.b.consume({ id: \"b.process\", handler: async () => { await resources.a.send({}); } });" }
    ];
    const forward = await compile({ resources: { a, b }, modules });
    const backward = await compile({ resources: { b, a }, modules: [...modules].reverse() });
    expect(canonicalJsonStringify(backward.events as never)).toBe(canonicalJsonStringify(forward.events as never));
    expect(backward.diagnostics).toEqual(forward.diagnostics);
  });
});
describe("validateEventAnalysis", () => {
  it("accepts a real analysis and returns an equal copy", async () => {
    const orders = queueHandle("orders");
    const result = await compile({
      resources: { orders },
      modules: [{ path: "src/orders.ts", exports: { processOrder: withEvents(queueConsumer("orders.process", "orders", message), { cycle: { justification: "Stops when done." } }) }, source: "import { resources } from \"@/infra\";\nimport { c } from \"x\";\nexport const processOrder = resources.orders.consume({ id: \"orders.process\", handler: async () => { await resources.orders.send({}); await c.send({}); } });" }]
    });
    const validated = validateEventAnalysis(JSON.parse(canonicalJsonStringify(result.events as never)));
    expect(validated).toEqual({ ok: true, value: result.events });
  });

  it.each([
    [undefined, "$ must be an object"],
    [{ graph: { nodes: [{ type: "topic" }], edges: [], unresolved: [] }, cycles: [] }, "$.graph.nodes[0].type"],
    [{ graph: { nodes: [], edges: [{ relation: "publishes", from: "a", to: "b", certainty: "unknown", operation: "send", origin: "analysis" }], unresolved: [] }, cycles: [] }, "$.graph.edges[0].certainty"],
    [{ graph: { nodes: [], edges: [], unresolved: [] }, cycles: [{ status: "reported", certainty: "known", handlers: [1], path: [] }] }, "$.cycles[0].handlers[0]"]
  ])("rejects %p naming the malformed path", (value, path) => {
    const validated = validateEventAnalysis(value);
    expect(validated.ok).toBe(false);
    if (!validated.ok) {
      expect(validated.error[0]!.code).toBe("HOLQA_ANALYSIS_FAILED");
      expect(validated.error[0]!.message).toContain(path);
    }
  });
});