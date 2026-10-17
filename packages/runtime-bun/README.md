# @holqa/runtime-bun (planned)

> **Status:** Planned. No code exists yet.

Executes Holqa handlers on Bun: HTTP and RPC request handling via `Bun.serve` and the Fetch API, invocation adapters for
queue, storage, and schedule events, and concurrency limits for multiple simultaneous invocations.

Boundaries: depends on `@holqa/core` only. See [triggers and execution](../../docs/concepts/triggers-and-execution.md)
and [ADR 0002](../../docs/architecture/decisions/0002-bun-as-primary-runtime.md).
