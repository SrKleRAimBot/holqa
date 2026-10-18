import type { StandardSchemaV1 } from "@holqa/core";
import type {
  CheckResourceId,
  CheckUniqueResourceIds,
  QueueMessageInput,
  QueueMessageOutput
} from "@holqa/sdk";

import type {
  Accepts,
  Equal,
  Expect,
  ExpectFalse,
  Extends,
  HasTypeError,
  IsAny,
  IsNever,
  IsUnknown,
  NotEqual,
  TypeErrorMessage
} from "@/type-assertions";

import { queue } from "@holqa/sdk";
import {
  describe,
  expect,
  it
} from "bun:test";

import { assertType } from "@/type-assertions";

/** A hand-written schema whose input is an ISO string and whose output is a `Date`. */
const timestamped: StandardSchemaV1<{ at: string }, { at: Date }> = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: value => typeof value === "object" && value !== null && "at" in value && typeof value.at === "string"
      ? { value: { at: new Date(value.at) } }
      : { issues: [{ message: "Expected { at: string }." }] }
  }
};

/** A queue declared with the SDK, used to exercise the assertions on real handle types. */
const events = queue({ id: "events", message: timestamped, schemaVersion: 1 });

/** Compile-time assertions about the generic utilities; checked by tsc. */
export type GenericAssertions = [
  Expect<Equal<{ a: 1 }, { a: 1 }>>,
  ExpectFalse<Equal<{ a: 1 }, { readonly a: 1 }>>,
  ExpectFalse<Equal<{ a?: 1 }, { a: 1 | undefined }>>,
  ExpectFalse<Equal<any, unknown>>,
  Expect<NotEqual<string, "a">>,
  Expect<IsAny<any>>,
  ExpectFalse<IsAny<unknown>>,
  Expect<IsNever<never>>,
  ExpectFalse<IsNever<undefined>>,
  Expect<IsUnknown<unknown>>,
  ExpectFalse<IsUnknown<any>>,
  Expect<Extends<"a", string>>,
  ExpectFalse<Extends<"a" | 1, string>>
];

/** Compile-time assertions about Holqa declarations; checked by tsc. */
export type HolqaAssertions = [
  Expect<Equal<QueueMessageInput<typeof events>, { at: string }>>,
  Expect<Equal<QueueMessageOutput<typeof events>, { at: Date }>>,
  Expect<Accepts<typeof events.send, { at: string }>>,
  ExpectFalse<Accepts<typeof events.send, { at: Date }>>,
  ExpectFalse<Accepts<typeof events.send, { when: string }>>,
  Expect<HasTypeError<CheckResourceId<"Events">>>,
  ExpectFalse<HasTypeError<CheckResourceId<"events">>>,
  Expect<Equal<TypeErrorMessage<CheckResourceId<"events_v2">>, "Invalid identifier \"events_v2\": it may only contain lowercase letters, digits, \"-\" and \".\".">>,
  Expect<HasTypeError<CheckUniqueResourceIds<{ a: typeof events; b: typeof events }>>>
];

describe("type assertions", () => {
  it("reject failing assertions at compile time", () => {
    // @ts-expect-error -- the types differ, so Expect rejects the assertion.
    type Failing = Expect<Equal<{ a: 1 }, { a: 2 }>>;
    // @ts-expect-error -- a passing check reports no message, so HasTypeError is false.
    type NoError = Expect<HasTypeError<CheckResourceId<"valid-id">>>;
    const assertions: [Failing?, NoError?] = [];
    expect(assertions).toEqual([]);
  });

  it("assertType checks the inferred type of a value and has no run-time effect", () => {
    assertType<"events">(events.id);
    // @ts-expect-error -- the identifier is the literal "events", not "orders".
    assertType<"orders">(events.id);
    expect(assertType(1)).toBeUndefined();
  });
});