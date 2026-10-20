# Conformance

> **Status:** **Implemented** in `@holqa/conformance` (private, unpublished) and `holqa providers test` in `@holqa/cli`.

The conformance suites state each binding contract's normative behaviour as executable cases, so every provider proves the same semantics: the local providers, `@holqa/rabbitmq` and `@holqa/s3` run them in their own tests, in memory and against real infrastructure.

## Suites

| Suite | Contract | Cases (summary) | Run against |
| --- | --- | --- | --- |
| `queueConformance` | `queue` | delivery unchanged with identifier and attempt 1; distinct identifiers; leases exclude redelivery; batch limits; acknowledgement; retries no earlier than the delay with a higher attempt; lease expiry redelivers; lease extension; dead-lettering; discarding; delayed sends; trace and lineage travel with the message; `wait` honours its signal | local (memory, SQLite), RabbitMQ (in-memory broker, RabbitMQ 4) |
| `bucketConformance` | `bucket` | byte-for-byte reads with metadata; keys with spaces and non-ASCII characters; missing objects; overwrites change the etag; deletion; sorted, prefix-filtered, paged listing; signed URLs | local, S3 (in-memory store, RustFS) |
| `bucketEventsConformance` | `bucket.events` | created and deleted events with the object's identity; type and prefix filters; independent subscriptions; redelivery with the same identifier | local, S3 with an event channel (in-memory) |
| `scheduleConformance` | `schedule` | one run per due time with its scheduled time; no runs after a subscription stops | local |

A case that does not apply to what a provider advertises skips itself (`ConformanceSkip`); anything else that throws fails it.

## Running suites

| Where | How |
| --- | --- |
| A provider's own tests | `registerConformance(suite, harness, { describe, it }, timeoutMs?)` registers the cases with `bun:test`, Vitest or Jest. |
| Programmatically | `runConformance(suite, harness)` returns one `ConformanceResult` (`contract`, `name`, `status`, `message`, `durationMs`) per case. |
| Against configured providers | A module whose default export is `defineProviderTests([providerTest(name, suite, harness), ...])`, run by `holqa providers test`. |

A harness supplies `open()` (a fresh, empty fixture per case, with `close()` to release it) and `time` (`advance(ms)`, and `now()` for virtual clocks). `providerTest` type-checks the harness against the suite.

`holqa providers test [--tests <path>] [--only <names>] [--timeout <ms>] [--json]` loads the module (default `conformance.ts` next to the application module) in a separate Bun process with the CLI's environment, so harnesses can reach real infrastructure with real credentials. It runs every case with a fresh harness and a time limit (default 30 000 ms), prints one line per case and a summary, and exits with `1` when a case fails. With `--json`, the `holqa.provider-tests/1` report: `suites` (`name`, `contract`, `results`) and `summary` (`passed`, `failed`, `skipped`). `runProviderTests(tests, { only?, timeoutMs? })` produces the same report in code.

## Coverage of the binding layer's test categories

Besides the suites, the binding layer's behaviour is covered by package tests. The table maps each category to representative tests; every row was checked against the repository.

| Category | Behaviour | Representative tests |
| --- | --- | --- |
| Type-level | Handle inference, invalid and missing bindings, extension and configuration types | `packages/sdk/tests/index.test.ts`, `packages/bindings/tests/define-bindings.test.ts` (`@ts-expect-error` for wrong kinds, unknown resources, resources without a provider), `packages/sdk/tests/app/extensions.test.ts` |
| Core behaviour | Lifecycle order, error normalization, context propagation | `packages/runtime-bun/tests/runtime/binding-lifecycle.test.ts`, `packages/bindings/tests/create-binding.test.ts`, `packages/core/tests/binding/failures.test.ts`, `packages/runtime-bun/tests/delivery/delivery-worker.test.ts` |
| Messaging reliability | Publication, acknowledgement, retries, dead-lettering, duplicates, reconnection, lease expiry, shutdown during execution, schema incompatibility | `queueConformance`; `packages/providers/rabbitmq/tests/provider.test.ts` (lost connections, unsettled deliveries returned on stop, quarantine of malformed messages); `packages/local/tests/environment.test.ts` (duplicates, contract failures dead-lettered without invoking the consumer); `packages/container/tests/start.test.ts` (drain on stop) |
| Storage and scheduling | Object operations, metadata, events, redelivered events, filters, scheduled runs, missed runs and overlap, virtual time | `bucketConformance`, `bucketEventsConformance`, `scheduleConformance`; `packages/local/tests/schedule/local-scheduler.test.ts` (missed runs after a late wake-up); `packages/local/tests/environment.test.ts` (overlapping runs skipped); `packages/testing/tests/app/create-test-app.test.ts` (virtual time) |
| Observability and safety | Trace propagation across providers, lineage, causal metadata, execution limits, exporter failures, redaction | `queueConformance` (trace and lineage through RabbitMQ), `packages/providers/s3/tests/provider.test.ts` (trace through object metadata), `packages/testing/tests/app/event-safety.test.ts`, `packages/runtime-bun/tests/telemetry/pipeline.test.ts`, `packages/core/tests/observability/redaction.test.ts` |
| Provider composition | Defaults, kind and resource overrides, service overrides, missing capabilities, incompatible versions, extensions, replicas | `packages/bindings/tests/resolve.test.ts`, `packages/bindings/tests/validate.test.ts`, `packages/core/tests/binding/validate-provider.test.ts`, `packages/testing/tests/bindings/extensions.test.ts` |
| Fault injection | Unavailability, lost connections, timeouts, cancellation, invalid credentials, initialization failures, partial shutdown | `packages/testing/tests/bindings/faulty-provider.test.ts` (`withFaults`), `packages/runtime-bun/tests/dispatch/dispatcher.test.ts`, the providers' classification tests |
| End to end | One application in three environments on real infrastructure | `examples/document-processing/tests/environments.test.ts` |

Fast tests use in-memory fakes and virtual clocks and need no broker. Integration tests run when their environment variables are set (`HOLQA_RABBITMQ_URL`, `HOLQA_S3_*`), as CI's provider job does with RabbitMQ 4 and RustFS service containers.

## Related

- [Provider authoring guide](../guides/provider-authoring.md)
- [Binding contracts](bindings.md)
