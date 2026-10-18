import {
  compiledShop,
  copy
} from "@test/support/manifests";

import {
  describe,
  expect,
  it
} from "bun:test";
import { buildResourceGraph } from "@/index";

describe("buildResourceGraph", () => {
  it("connects the application, resources, handlers, configuration and schemas", async () => {
    const { manifest } = await compiledShop();
    const graph = buildResourceGraph(manifest);
    const edges = graph.edges.filter(edge => edge.relation !== "schema").map(edge => `${edge.from} -${edge.relation}${edge.label === undefined ? "" : `(${edge.label})`}-> ${edge.to}`);
    expect(edges).toEqual([
      "application:shop -requires-> config:DATABASE_URL",
      "application:shop -requires-> config:LOG_LEVEL",
      "application:shop -registers-> handler:orders.get",
      "application:shop -registers-> handler:orders.list",
      "application:shop -registers-> handler:orders.process",
      "application:shop -registers-> handler:receipts.stored",
      "application:shop -registers-> handler:reports.nightly",
      "application:shop -declares-> resource:nightly-report",
      "application:shop -declares-> resource:order-placed",
      "application:shop -declares-> resource:receipts",
      "application:shop -declares-> resource:shop-api",
      "resource:nightly-report -triggers(schedule.tick)-> handler:reports.nightly",
      "resource:order-placed -triggers(queue.message)-> handler:orders.process",
      "resource:receipts -triggers(bucket.object-created)-> handler:receipts.stored",
      "resource:shop-api -triggers(http.route)-> handler:orders.get",
      "resource:shop-api -triggers(http.route)-> handler:orders.list"
    ]);
    expect(graph.nodes.find(node => node.key === "resource:order-placed")).toEqual({
      key: "resource:order-placed",
      type: "resource",
      id: "order-placed",
      kind: "queue",
      capabilities: ["queue", "queue.dead-letter", "queue.delivery.at-least-once", "queue.max-attempts"]
    });
    const { message } = manifest.resources.find(resource => resource.id === "order-placed")!.schemas;
    const fingerprint = message!.fingerprint;
    expect(graph.edges.filter(edge => edge.to === `schema:${fingerprint}`).map(edge => `${edge.from} ${edge.label}`)).toEqual([
      "handler:orders.get response.200",
      "handler:orders.process message",
      "resource:order-placed message"
    ]);
  });

  it("is deterministic for equal manifests", async () => {
    const { manifest } = await compiledShop();
    expect(buildResourceGraph(copy(manifest))).toEqual(buildResourceGraph(manifest));
  });
});