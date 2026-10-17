# @holqa/testing

Testing utilities for Holqa applications.

> **Status:** Implemented in part, private and unpublished. Today it contains compile-time type assertions. Fixtures,
> deterministic event delivery, simulated failures and retries are planned.

## Contents

| Export | Purpose |
| --- | --- |
| `Equal`, `NotEqual`, `Expect`, `ExpectFalse` | Exact type equality and compile-time assertions. |
| `IsAny`, `IsNever`, `IsUnknown`, `Extends` | Type predicates. |
| `Accepts<Fn, Arg>` | Whether a handle operation accepts an argument type. |
| `TypeErrorMessage`, `HasTypeError` | Inspect the SDK's compile-time declaration checks. |
| `assertType<T>(value)` | Checks a value's type at compile time; does nothing at run time. |

```ts
import type { Accepts, Equal, Expect, ExpectFalse } from "@holqa/testing";
import type { QueueMessageInput } from "@holqa/sdk";

import { resources } from "./infra";

export type OrderContract = [
  Expect<Equal<QueueMessageInput<typeof resources.orders>, { orderId: string }>>,
  ExpectFalse<Accepts<typeof resources.orders.send, { id: string }>>
];
```

Assertions are checked by `tsc --noEmit`, not by the test runner.

Boundaries: may depend on `@holqa/core`, `@holqa/sdk`, `@holqa/local`, and `@holqa/runtime-bun`; today it depends on
`@holqa/sdk` only.
