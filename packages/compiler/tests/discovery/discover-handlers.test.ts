import {
  described,
  module,
  scheduleHandler
} from "@test/support/application";

import {
  describe,
  expect,
  it
} from "bun:test";
import { discoverHandlers } from "@/discovery/discover-handlers";

describe("discoverHandlers", () => {
  it("attributes a re-exported handler to the first module by path", () => {
    const handler = scheduleHandler("reports.nightly", "nightly");
    const { handlers, diagnostics } = discoverHandlers([module("src/z.ts", { default: handler }), module("src/index.ts", { nightly: handler, other: 1 })]);
    expect(diagnostics).toEqual([]);
    expect(handlers.map(entry => [entry.descriptor.definition.id, entry.module, entry.exports])).toEqual([["reports.nightly", "src/index.ts", ["nightly"]]]);
  });

  it("returns distinct registrations that share an id, ordered by module", () => {
    const { handlers } = discoverHandlers([module("src/b.ts", { default: scheduleHandler("x", "nightly") }), module("src/a.ts", { default: scheduleHandler("x", "nightly") })]);
    expect(handlers.map(entry => entry.module)).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("ignores plain values and readable non-handler descriptors", () => {
    const resource = described({ protocol: 1, type: "resource" });
    expect(discoverHandlers([module("src/a.ts", { value: 1, nothing: null, fn: () => 1, resource })])).toEqual({ handlers: [], diagnostics: [] });
  });

  it("reports unreadable handler descriptors", () => {
    const { diagnostics } = discoverHandlers([module("src/a.ts", { broken: described({ protocol: 1, type: "handler", definition: {} }) })]);
    expect(diagnostics).toEqual([expect.objectContaining({ code: "HOLQA_DECLARATION_INVALID", location: { file: "src/a.ts" } })]);
  });
});