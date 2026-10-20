import { queueHandle } from "@test/support/events";
import {
  describe,
  expect,
  it
} from "bun:test";

import {
  analyzePublications,
  fallbackResolve
} from "@/events/publications";

/** Resource handles exported by the fixture's `infra.ts`. */
const orders = queueHandle("orders");

/** Namespaces of the fixture's evaluated modules. */
const namespaces = new Map<string, Readonly<Record<string, unknown>>>([["infra.ts", { resources: { orders: orders.handle } }]]);

/**
 * Analyzes one handler of a module.
 *
 * @param source - The handler module's source.
 * @param id - The handler's identifier.
 * @param extra - Further sources.
 * @returns The handler's analysis.
 */
async function analyze(source: string, id = "orders.process", extra: Readonly<Record<string, string>> = {}): Promise<Awaited<ReturnType<typeof analyzePublications>>[number]> {
  const [result] = await analyzePublications({ handlers: [{ id, module: "src/orders.ts" }], sources: { "src/orders.ts": source, ...extra }, namespaces });
  return result!;
}

describe("analyzePublications", () => {
  it("finds the handler in method shorthand and by reference", async () => {
    const shorthand = await analyze("import { resources } from \"@/infra\";\nexport const a = resources.orders.consume({ id: \"orders.process\", async handler() { await resources.orders.send({}); } });");
    expect(shorthand).toMatchObject({ coverage: "complete", publications: [{ certainty: "known", target: { kind: "queue", id: "orders" } }] });
    const reference = await analyze("import { resources } from \"@/infra\";\nexport const a = resources.orders.consume({ id: \"orders.process\", handler });\nfunction handler() { return resources.orders.send({}); }");
    expect(reference.publications).toMatchObject([{ certainty: "known", location: { line: 3 } }]);
  });

  it("only walks the handler's own code, not other registrations in the module", async () => {
    const result = await analyze("import { resources } from \"@/infra\";\nexport const a = resources.orders.consume({ id: \"orders.process\", handler: () => {} });\nexport const b = resources.orders.consume({ id: \"other\", handler: () => resources.orders.send({}) });");
    expect(result).toEqual({ handler: "orders.process", coverage: "complete", publications: [] });
  });

  it("falls back to the whole module, as potential publications, when the registration cannot be found", async () => {
    const result = await analyze("import { resources } from \"@/infra\";\nconst ID = \"orders.process\";\nexport const a = resources.orders.consume({ id: ID, handler: () => resources.orders.send({}) });");
    expect(result).toMatchObject({ coverage: "partial", publications: [{ certainty: "potential" }] });
  });

  it("reports handlers without readable source as unavailable", async () => {
    expect((await analyzePublications({ handlers: [{ id: "x", module: "src/missing.ts" }], sources: {}, namespaces })).map(entry => entry.coverage)).toEqual(["unavailable"]);
    expect((await analyze("export const a = f(\"unterminated);")).coverage).toBe("unavailable");
  });

  it("stops following helpers after four calls and never loops on recursion", async () => {
    const source = [
      "import { resources } from \"@/infra\";",
      "export const a = resources.orders.consume({ id: \"orders.process\", handler: () => one() });",
      "function one() { return two(); }",
      "function two() { return three(); }",
      "function three() { return four(); }",
      "function four() { return five(); }",
      "function five() { return resources.orders.send({}); }",
      "function loop() { return loop(); }"
    ].join("\n");
    expect((await analyze(source)).publications).toEqual([]);
    const recursive = await analyze("import { resources } from \"@/infra\";\nexport const a = resources.orders.consume({ id: \"orders.process\", handler: () => loop() });\nfunction loop() { loop(); return resources.orders.send({}); }");
    expect(recursive.publications).toMatchObject([{ certainty: "potential", via: ["loop"] }]);
  });

  it("uses the host's resolver when given, and treats its failures as unresolved", async () => {
    const [resolved] = await analyzePublications({
      handlers: [{ id: "orders.process", module: "src/orders.ts" }],
      sources: { "src/orders.ts": "import { resources } from \"#app\";\nexport const a = resources.orders.consume({ id: \"orders.process\", handler: () => resources.orders.send({}) });" },
      namespaces: new Map(),
      resolve: async specifier => specifier === "#app" ? { path: "app.ts", exports: { resources: { orders: orders.handle } } } : undefined
    });
    expect(resolved!.publications).toMatchObject([{ certainty: "known" }]);
    const [failed] = await analyzePublications({
      handlers: [{ id: "orders.process", module: "src/orders.ts" }],
      sources: { "src/orders.ts": "import { resources } from \"#app\";\nexport const a = resources.orders.consume({ id: \"orders.process\", handler: () => resources.orders.send({}) });" },
      namespaces: new Map(),
      resolve: async () => {
        throw new Error("resolution failed");
      }
    });
    expect(failed!.publications).toMatchObject([{ certainty: "unknown" }]);
  });
});

describe("fallbackResolve", () => {
  const paths = ["infra.ts", "src/lib/index.ts", "src/lib/queue.ts", "src/a.ts"];
  const known = new Map<string, Readonly<Record<string, unknown>>>([["infra.ts", { x: 1 }]]);

  it.each([
    ["./lib/queue", "src/a.ts", "src/lib/queue.ts"],
    ["./lib/queue.js", "src/a.ts", "src/lib/queue.ts"],
    ["./lib", "src/a.ts", "src/lib/index.ts"],
    ["../infra", "src/a.ts", "infra.ts"],
    ["@/infra", "src/a.ts", "infra.ts"],
    ["@/app/infra", "src/a.ts", "infra.ts"],
    ["~/src/lib/queue", "src/a.ts", "src/lib/queue.ts"]
  ])("resolves %p from %p to %p", (specifier, from, path) => {
    expect(fallbackResolve(specifier, from, paths, known)?.path).toBe(path);
  });

  it("returns the namespace of evaluated modules", () => {
    expect(fallbackResolve("../infra", "src/a.ts", paths, known)).toEqual({ path: "infra.ts", exports: { x: 1 } });
  });

  it.each(["zod", "../../outside", "./missing", "@/nothing"])("does not resolve %p", (specifier) => {
    expect(fallbackResolve(specifier, "src/a.ts", paths, known)).toBeUndefined();
  });
});