# @holqa/conformance

A reusable conformance suite for Holqa binding providers: the normative behaviour of the `queue`, `bucket`,
`bucket.events` and `schedule` contracts as runnable cases.

> **Status:** Implemented, private and unpublished. The API may change before the first release.

```ts
import { queueConformance, registerConformance } from "@holqa/conformance";
import { describe, it } from "bun:test";

registerConformance(queueConformance, {
  time: { advance: ms => Bun.sleep(ms) },
  open: async () => ({ driver, source, capabilities, close })
}, { describe, it });
```

`driver`, `source`, `capabilities` and `close` stand for a fresh queue of the provider under test.

Cases throw `ConformanceFailure` when a provider breaks the contract and `ConformanceSkip` when a case does not apply
to the capabilities it advertises. `runConformance` runs a suite without a test runner. The package depends on
`@holqa/core` only. See the [binding contracts reference](../../docs/reference/bindings.md#conformance).
