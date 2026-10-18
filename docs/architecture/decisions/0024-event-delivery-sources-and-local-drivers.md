# 0024. Event delivery through binding sources, with local drivers as the first binding

- **Status:** Proposed
- **Date:** 2026-10-18
- **Deciders:** Holqa maintainers
- **Refines:** [ADR 0005](0005-infrastructure-independent-resource-contracts.md), [ADR 0020](0020-runtime-binding-resolution.md), [ADR 0021](0021-schema-contracts-wire-payloads-and-compatibility.md), [ADR 0022](0022-manifest-v1-and-entry-point-map.md) decision 4, [ADR 0023](0023-common-invocation-engine-and-http-rpc-execution.md). It supersedes none of them.

> **Implementation status:** Implemented in `@holqa/core` (contracts, object event envelope, cron evaluation, backoff), `@holqa/sdk` (queue, bucket and schedule operations), `@holqa/compiler` (the `bucket.object-deleted` trigger and queue backoff in manifest version 1), `@holqa/runtime-bun` (delivery transports) and the new `@holqa/local` package. Provider bindings remain **Planned**. See the [runtime reference](../../reference/runtime.md#queue-delivery) and the [local environment reference](../../reference/local.md).

## Context

ADR 0023 made every invocation go through one dispatcher, but only HTTP and RPC had transports: queue consumers, object-created handlers and schedule handlers could run only through `runtime.invoke`. Running an event-driven application needs:

- a way for a runtime to *consume* resources (lease queue messages, receive object events, receive due schedule runs), not only to use them from handler code through drivers;
- delivery policy (retries, backoff, dead-lettering, bounded concurrency, graceful shutdown) that behaves the same whatever fulfils the resource, so applications do not change behaviour between local runs and production;
- a portable event envelope for storage events that external drivers can produce later, with explicit identity so duplicates can be detected;
- schedule semantics that are defined, not inherited from whatever scheduler happens to run them: time zones, daylight-saving transitions, missed runs, overlap;
- a local binding that runs all of this without cloud credentials and without promising more than production services.

Constraints: `@holqa/core` stays runtime-neutral; `@holqa/runtime-bun` depends on `@holqa/core` only; `@holqa/local` may depend on `@holqa/core` and `@holqa/runtime-bun` ([package boundaries](../package-boundaries.md)); drivers must not need provisioning permissions; requirements are never weakened.

## Decision

1. **Sources are the consuming half of a binding.** `RuntimeBinding` gains an optional `sources` record (`queue`, `bucket`, `schedule`). Drivers stay the data plane that handles call; sources are what a runtime consumes. A binding without a source for a handler's trigger cannot deliver it, and `runtime.start()` fails with `HOLQA_RUNTIME_START_FAILED` and a `HOLQA_BINDING_CAPABILITY_UNSUPPORTED` cause per handler instead of leaving the handler silently undelivered. The check is `checkTriggerDelivery` in `@holqa/core`, so tools other than the Bun runtime can apply it. `manualTriggers: true` keeps such handlers invoke-only.
2. **Leased deliveries.** Queue messages and object events share one contract, `DeliverySource<Body>`: `receive({ max, leaseMs })` leases due deliveries; `acknowledge`, `retry(delayMs)`, `deadLetter` and `discard` settle them and report `false` when the lease was lost; `wait(signal)` blocks until work may be due; an optional `extend` renews a held lease, which the runtime does every half lease while a handler runs. A lease that expires makes the delivery due again with a higher attempt: delivery is at least once. A source must honour a retry delay or reject it, never shorten it.
3. **Policy lives in the runtime.** One delivery worker in `@holqa/runtime-bun` applies the declared policy for every binding: `maxAttempts` (the binding's default when absent), `backoff` (new queue requirement: `fixed` or `exponential`, computed without jitter by `backoffDelaySeconds`; default 1 s doubling to 300 s), dead-letter or discard after the last attempt, and immediate dead-lettering of deliveries no retry can fix (a payload that fails the schema, an older `schemaVersion`, a malformed envelope, or more receipts than attempts allow: `HOLQA_DELIVERY_ATTEMPTS_EXHAUSTED`). A newer `schemaVersion` is a failed attempt that is retried, because it usually means producers were deployed before the consumer. The default backoff is checked against the binding's `maxDelaySeconds` like a declared one. Workers lease at most as many deliveries as the consumer's `concurrency` can run. On stop, workers stop receiving first, in-flight invocations drain within the grace period, and deliveries cancelled by the shutdown are released for redelivery.
4. **Envelopes.** Queue drivers now receive the `holqa.message/1` envelope (`MessageEnvelope`) built by the SDK with the queue's `schemaVersion`, and return `{ messageId }`. Storage events use a new portable envelope, `holqa.object-event/1` (`ObjectEvent`: `id`, `type` `object.created` or `object.deleted`, `bucket`, `time`, `object`), checked by `readObjectEvent`. The event `id` is stable across redeliveries; handlers receive it as `event.id`.
5. **Storage API.** Buckets gain `head`, `delete`, `list` (bounded pages of at most 1 000 keys in UTF-8 byte order, with an opaque cursor) and `signedUrl` (`GET` or `PUT`, bounded by the binding's advertised `signedUrls.maxExpiresInSeconds`); `put` returns metadata with an opaque `etag`. Keys follow portable rules (`checkObjectKey`, `HOLQA_OBJECT_KEY_INVALID`). A new trigger, `bucket.object-deleted`, complements `bucket.object-created`; both accept a `prefix`. Each handler is its own subscription with independent delivery state. For external services a subscription is infrastructure that provisioning creates; `subscribe` attaches to it and must fail when it is missing, never create it with data-plane credentials (the local binding is its own provisioner). Object event retry settings are a runtime deployment setting (`delivery.objectEvents`), not a declared requirement. What a signed URL's signature guarantees is a property of the binding, documented by it.
6. **Schedules.** `@holqa/core` evaluates cron (`parseCronSchedule`, `nextCronTime`): five fields with names, ranges, steps and lists; classic day-of-month/day-of-week OR semantics; `L`, `W`, `#` and seconds are rejected (now also at declaration time). Fields match the wall clock in the declared IANA time zone; a matching local time inside a daylight-saving gap runs once at the end of the gap, and a repeated local time runs once at its first occurrence. A scheduler source reports due runs; the runtime applies the overlap policy (`skip` reports `HOLQA_SCHEDULE_RUN_SKIPPED`) and returns each run's result to the scheduler. Missed runs are not backfilled: runs due while no runtime receives the schedule never run, and after a late wake-up only the latest due run starts while the earlier ones are recorded as `missed`. These are requirements on schedule bindings, which evaluate them or must refuse a schedule they cannot honour; scheduler services may report a run more than once, so handlers must be idempotent.
7. **Local drivers.** `@holqa/local` provides the first binding with sources: queue and object event state in SQLite (`bun:sqlite`, write-ahead logging), object bytes in files named by a hash of the key, a scheduler driven by an injectable `Clock` (`ManualClock` for tests), inspection and failure simulation (dead letters, redrive, duplicate delivery), and development signed URLs (HMAC-SHA256 with a key kept in the state directory). Its advertised capabilities match common production services rather than what a local process could do (for example at most 900 seconds of delay).
8. **Manifest version 1 is extended again**, as ADR 0023 decision 9 allows: queue requirements may carry `backoff`, and the `bucket.object-deleted` trigger exists. Manifests that use neither are unchanged byte for byte; readers built before this change reject manifests that do.

## Consequences

### Positive

- Event-driven applications run locally end to end, through the same dispatcher, limits and logs as HTTP, as the [document-processing example](../../../examples/document-processing/README.md) shows.
- Retry and dead-letter behaviour is identical across bindings, and testable deterministically with a manual clock.
- External drivers can be written against small contracts (`DeliverySource`, `ObjectEventSource`, `ScheduleSource`) and reuse the envelopes and cron rules.

### Negative

- The runtime decides retries, so services with their own redrive policies need a driver that defers to the runtime (or advertises capabilities that make the runtime's policy redundant); this is not designed yet.
- Breaking changes for binding implementers: `QueueDriver.send` takes the envelope and options and returns a receipt; `BucketDriver` has four more required operations; object-created metadata now requires `eventId`, `eventTime` and `attempt`, so direct `runtime.invoke` calls must pass them. Declarations that used cron extensions now fail at declaration time.
- Schedule semantics are not yet negotiated as capabilities: a binding for a scheduler service must translate them faithfully or refuse the schedule, and the local scheduler reports each run exactly once, which is stronger than many services.
- Object event retry settings live in runtime options, so two deployments with different options behave differently; declaring them per handler is open.
- Local subscription records of removed handlers are not cleaned up yet.
- Overlap is enforced per runtime: two runtimes consuming one scheduler would each apply `skip` on their own. Local inspection is per state directory, and cross-process notification falls back to polling.
- Publishing and database writes stay separate operations; Holqa does not make them atomic. Applications need an outbox and idempotent consumers ([guidance](../../reference/runtime.md#publishing-and-database-writes)).

### Revisit when

- The first provider binding shows that delivery policy must be split between runtime and service.
- Topics (fan-out) are designed; queues deliberately keep one competing consumer.
- Worker isolation needs leases that outlive one runtime process.

## Alternatives considered

### Retry policy inside each driver

Each binding would implement retries, backoff and dead-lettering. Rejected: behaviour would drift between bindings, and the local driver could not prove that production would behave the same.

### Push-based delivery for queues

Sources would call the runtime for every message. Rejected for queues and object events: pull with leases bounds in-flight work by the consumer's concurrency and maps directly onto lease-based services. Schedules are push-based, because schedulers decide when runs are due.

### Provider event formats as handler input

Handlers would receive each service's notification shape. Rejected: it would leak provider types into the portable SDK ([ADR 0005](0005-infrastructure-independent-resource-contracts.md)).

## Related

- [Runtime reference](../../reference/runtime.md)
- [Local environment reference](../../reference/local.md)
- [Triggers and execution](../../concepts/triggers-and-execution.md)
- [Local development](../../concepts/local-development.md)
