import {
  describe,
  expect,
  it
} from "bun:test";

import {
  childTrace,
  lineageOfDelivery
} from "@/binding/trace";

describe("lineageOfDelivery", () => {
  it("starts a new lineage rooted at the fallback when the delivery carries no trace", () => {
    expect(lineageOfDelivery(undefined, "msg-1")).toEqual({ correlationId: "msg-1", rootId: "msg-1", depth: 0 });
  });

  it("keeps the correlation, cause, root and depth of a full trace", () => {
    expect(lineageOfDelivery({ correlationId: "c-1", causationId: "inv-1", rootId: "inv-0", depth: 3 }, "msg-1"))
      .toEqual({ correlationId: "c-1", causationId: "inv-1", rootId: "inv-0", depth: 3 });
  });

  it("roots a trace without lineage at the delivery, never at the caller-chosen correlation", () => {
    expect(lineageOfDelivery({ correlationId: "c-1", causationId: "inv-1" }, "msg-1")).toEqual({ correlationId: "c-1", causationId: "inv-1", rootId: "msg-1", depth: 0 });
  });

  it.each([
    { rootId: "", depth: 1 },
    { rootId: "r", depth: -1 },
    { rootId: "r", depth: 1.5 },
    { rootId: "r", depth: Number.NaN }
  ])("does not trust a malformed lineage ($rootId, $depth)", ({ rootId, depth }) => {
    expect(lineageOfDelivery({ correlationId: "c-1", rootId, depth }, "msg-1")).toEqual({ correlationId: "c-1", rootId: "msg-1", depth: 0 });
  });

  it("starts a new lineage when the correlation is malformed", () => {
    expect(lineageOfDelivery({ correlationId: "" }, "msg-1")).toEqual({ correlationId: "msg-1", rootId: "msg-1", depth: 0 });
  });
});

describe("childTrace", () => {
  it("keeps correlation and root, names the publisher as the cause and adds one hop", () => {
    expect(childTrace({ correlationId: "c-1", rootId: "inv-0", depth: 2, causationId: "inv-x" }, "inv-1")).toEqual({ correlationId: "c-1", causationId: "inv-1", rootId: "inv-0", depth: 3 });
  });

  it("round-trips through lineageOfDelivery", () => {
    const root = lineageOfDelivery(undefined, "inv-0");
    const delivered = lineageOfDelivery(childTrace(root, "inv-0"), "unused");
    expect(delivered).toEqual({ correlationId: "inv-0", causationId: "inv-0", rootId: "inv-0", depth: 1 });
  });
});