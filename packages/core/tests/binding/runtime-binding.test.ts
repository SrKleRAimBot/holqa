import {
  describe,
  expect,
  it
} from "bun:test";

import { createBindingSlot } from "@/binding/runtime-binding";

describe("createBindingSlot", () => {
  it("creates an empty slot that cannot gain other properties", () => {
    const slot = createBindingSlot();
    expect(slot.current).toBeUndefined();
    expect(Object.isSealed(slot)).toBe(true);
  });
});