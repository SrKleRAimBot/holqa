import {
  describe,
  expect,
  it
} from "bun:test";

import { checkIdentities } from "@/resources/identity-check";

describe("checkIdentities", () => {
  it("accepts unique, valid identifiers", () => {
    expect(checkIdentities([{ id: "orders", label: "resources.orders" }, { id: "files", label: "resources.files" }], "resource")).toEqual([]);
  });

  it("reports every invalid and duplicated identifier at once, in declaration order", () => {
    const diagnostics = checkIdentities([
      { id: "orders", label: "resources.orders" },
      { id: "Bad", label: "resources.bad" },
      { id: "orders", label: "resources.orderQueue" },
      { id: 7, label: "resources.number" },
      { id: "orders", label: "resources.third" }
    ], "resource");
    expect(diagnostics.map(diagnostic => diagnostic.code)).toEqual(["HOLQA_RESOURCE_ID_INVALID", "HOLQA_RESOURCE_ID_INVALID", "HOLQA_RESOURCE_ID_DUPLICATE"]);
    expect(diagnostics[0]!.message).toBe("resources.bad: Resource identifier \"Bad\" is invalid.");
    expect(diagnostics[2]!.message).toBe("The resource identifier \"orders\" is declared more than once: resources.orders, resources.orderQueue, resources.third.");
  });
});