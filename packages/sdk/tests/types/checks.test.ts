import type {
  CheckResourceId,
  CheckUniqueResourceIds,
  DuplicateResourceIds,
  HolqaTypeError,
  ResourceIdProblem
} from "@/index";

import {
  describe,
  expect,
  expectTypeOf,
  it
} from "bun:test";

describe("ResourceIdProblem", () => {
  it("accepts valid and non-literal identifiers", () => {
    expectTypeOf<ResourceIdProblem<"orders">>().toEqualTypeOf<never>();
    expectTypeOf<ResourceIdProblem<"order-processing.v2">>().toEqualTypeOf<never>();
    expectTypeOf<ResourceIdProblem<string>>().toEqualTypeOf<never>();
    expectTypeOf<CheckResourceId<"orders">>().toEqualTypeOf<unknown>();
  });

  it("leaves identifiers built from template literals to the run-time check", () => {
    expectTypeOf<ResourceIdProblem<`${string}-orders`>>().toEqualTypeOf<never>();
    expectTypeOf<ResourceIdProblem<`orders-${string}`>>().toEqualTypeOf<never>();
    expectTypeOf<CheckResourceId<`tenant-${number}`>>().toEqualTypeOf<unknown>();
  });

  it("checks each member of a union and names the invalid one", () => {
    expectTypeOf<CheckResourceId<"orders" | "Bad">>().toEqualTypeOf<HolqaTypeError<"Invalid identifier \"Bad\": it must start with a lowercase letter.">>();
    expectTypeOf<CheckResourceId<"orders" | "files">>().toEqualTypeOf<unknown>();
  });

  it("names the grammar rule a literal identifier breaks", () => {
    expectTypeOf<ResourceIdProblem<"">>().toEqualTypeOf<"it must not be empty">();
    expectTypeOf<ResourceIdProblem<"Orders">>().toEqualTypeOf<"it must start with a lowercase letter">();
    expectTypeOf<ResourceIdProblem<"1orders">>().toEqualTypeOf<"it must start with a lowercase letter">();
    expectTypeOf<ResourceIdProblem<"order_queue">>().toEqualTypeOf<"it may only contain lowercase letters, digits, \"-\" and \".\"">();
    expectTypeOf<ResourceIdProblem<"orders-">>().toEqualTypeOf<"it must not end with \"-\" or \".\"">();
    expectTypeOf<ResourceIdProblem<"orders.-x">>().toEqualTypeOf<"separators must not be adjacent">();
    expectTypeOf<ResourceIdProblem<"abcdefghijbcdefghijbcdefghijbcdefghijbcdefghijbcdefghijbcdefghij">>().toEqualTypeOf<"it must be at most 63 characters long">();
    expectTypeOf<ResourceIdProblem<"abcdefghijbcdefghijbcdefghijbcdefghijbcdefghijbcdefghijbcdefghi">>().toEqualTypeOf<never>();
    expectTypeOf<CheckResourceId<"Orders">>().toEqualTypeOf<HolqaTypeError<"Invalid identifier \"Orders\": it must start with a lowercase letter.">>();
    expect(true).toBe(true);
  });
});

describe("DuplicateResourceIds", () => {
  it("finds literal identifiers declared under more than one alias", () => {
    interface Record { a: { id: "x" }; b: { id: "y" }; c: { id: "x" }; d: { id: string } }
    expectTypeOf<DuplicateResourceIds<Record>>().toEqualTypeOf<"x">();
    expectTypeOf<DuplicateResourceIds<{ a: { id: "x" }; b: { id: "y" } }>>().toEqualTypeOf<never>();
    expectTypeOf<CheckUniqueResourceIds<{ a: { id: "x" }; b: { id: string } }>>().toEqualTypeOf<unknown>();
    expectTypeOf<CheckUniqueResourceIds<{ a: { id: `${string}-x` }; b: { id: `${string}-x` } }>>().toEqualTypeOf<unknown>();
    expectTypeOf<CheckUniqueResourceIds<Record>>().toEqualTypeOf<HolqaTypeError<"Resource identifier \"x\" is declared more than once. Every resource needs its own id.">>();
  });
});