---
"@holqa/local": minor
"@holqa/conformance": minor
"@holqa/bindings": patch
"@holqa/cli": patch
---

Offer the local binding as providers and add a reusable provider conformance suite.

- `@holqa/local`: `local.platform()`, `local.queues()`, `local.buckets()`, `local.schedules()` and `localEnvironment()` (providers sharing one state), with `persistence: "sqlite"` (default, durable across restarts) or `"memory"` (fast, ephemeral, for tests); `openLocalState`, the engine `createLocalEnvironment` now runs on (its behaviour is unchanged); object bytes behind a blob store (files or memory); the local telemetry store can live in memory.
- `@holqa/conformance` (new): runner-neutral cases for the `queue`, `bucket`, `bucket.events` and `schedule` contracts, with `runConformance` and `registerConformance`. The local providers pass all of them in both persistence modes.
- `@holqa/bindings`, `@holqa/cli`: the configuration-source convention is `settings.configSource` (renamed from `settings.source`, which was never released).
