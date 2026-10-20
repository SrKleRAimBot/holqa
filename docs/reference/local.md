# Local environment

> **Status:** **Implemented** in `@holqa/local` (private, unpublished). `holqa dev` and the operation commands (`invoke`, `queue send`, `queue redrive`, `storage put`, `cron run`, `state`) run applications on it ([CLI reference](cli.md)), and `createTestApp` in `@holqa/testing` runs it in tests ([local development guide](../guides/local-development.md)); it can also be created in code, as below.

`@holqa/local` is a runtime binding that fulfils an application's queues, buckets and schedules on one machine, without cloud credentials. It implements the same driver and source contracts as any other binding ([ADR 0024](../architecture/decisions/0024-event-delivery-sources-and-local-drivers.md)), so handler code does not change between local runs and other bindings. The delivery policy (retries, backoff, dead-lettering, concurrency) is applied by `@holqa/runtime-bun` and is the same for every binding ([runtime reference](runtime.md#queue-delivery)).

## Creating an environment

```ts
import { createLocalEnvironment } from "@holqa/local";
import { createRuntime, loadCompiledApplication } from "@holqa/runtime-bun";

const compiled = await loadCompiledApplication({ root: import.meta.dir });
const local = await createLocalEnvironment({ app: compiled.app, directory: ".holqa/local" });
const runtime = createRuntime({ ...compiled, binding: local.binding });
await runtime.start();

// Serve the API and the environment's signed URLs from one server.
Bun.serve({ hostname: "127.0.0.1", port: 3000, fetch: request => local.storage.handles(request) ? local.storage.fetch(request) : runtime.fetch(request) });
```

| Option | Default | Meaning |
| --- | --- | --- |
| `app` | required | The application: the default export of `infra.ts`. |
| `directory` | required | The state directory: `state.sqlite` and `objects/`. Created when missing; reusing it keeps queued messages, objects, events and run records across restarts. |
| `env` | `process.env` | Configuration values, validated like the runtime's default binding (`HOLQA_CONFIG_INVALID`). |
| `clock` | `systemClock` | The time source of delays, leases, signed URL expiry and schedules. Use `ManualClock` in tests. |
| `createId` | `crypto.randomUUID` | Identifiers of messages, events, runs and leases. |
| `queues.defaultMaxAttempts` | `5` | Attempts of queues that declare no `maxAttempts`. |
| `queues.pollIntervalMs` | `1000` | How often a waiting receiver looks for work added by another process sharing the directory. |
| `queues.retentionMs` | 24 hours | How long acknowledged messages stay visible to inspection. |
| `storage.signedUrlBase` | `http://127.0.0.1:3000/_holqa/storage` | Where signed URLs point. Serve them with `storage.fetch`. |
| `storage.maxUploadBytes` | 100 MiB | The largest signed upload; larger ones answer `413`. |

`createLocalEnvironment` resolves to `{ binding, clock, queues, storage, scheduler, settle, close }`. Stop runtimes that use the binding before `close()`.

## Capabilities

The binding advertises what it implements, and never more than common production services offer, so that an application that runs locally does not depend on guarantees it will not get elsewhere.

| Kind | Advertised |
| --- | --- |
| `queue` | At-least-once delivery, up to 100 attempts, dead-letter destination, `fixed` and `exponential` backoff, delays up to 900 seconds. |
| `bucket` | `private` and `public-read` access, `object.created` and `object.deleted` events, signed URLs valid for up to 7 days. |
| `schedule` | `skip` and `allow` overlap policies. |
| `http.api` | Served by the runtime. |
| Operation budgets | `binding.operationBudgets`: each request is one SQLite transaction, so every process that shares the state directory counts against one budget per root operation. Enables the runtime's `events.maxEventsPerOperation`. |
| Idempotency keys | `binding.idempotency`: claims and completed keys in the state database, durable across restarts and shared by every process using the directory. |

A declaration that needs more fails when the runtime starts: `HOLQA_RUNTIME_START_FAILED`, followed by one `HOLQA_BINDING_CAPABILITY_UNSUPPORTED` diagnostic per shortfall.

## Semantics

| Area | Local behaviour |
| --- | --- |
| Queue storage | Envelopes are stored in SQLite (`bun:sqlite`, write-ahead logging) and survive restarts. Several processes can share one directory; notifications between them fall back to polling. |
| Leases | A received message is leased for the runtime's `delivery.leaseMs` of clock time. A runtime that crashes or hangs loses its leases when they expire, and the message becomes due again with a higher attempt. A settlement after the message was leased again has no effect. |
| Duplicates and order | Duplicates happen after an expired lease and can be forced with `queues.duplicate`. Order is best effort (oldest due first), not guaranteed: retries and delays reorder messages. |
| Objects | Bytes are written to a temporary file, renamed into place under a name derived from a hash of the key, and then switched in the metadata in one transaction, so readers never see a partly written object and keys never become file system paths. The `etag` is the SHA-256 of the content. |
| Events | Written in the same transaction as the metadata change, as one delivery per matching subscription, and due at once. Notifications from storage services are asynchronous and can arrive late; do not rely on an event being delivered before a later request reads the object. A subscription keeps receiving events while its runtime is stopped and catches up when it starts again. `storage.retainSubscriptions` removes the subscriptions of handlers that no longer exist, and every `holqa dev` generation calls it when it starts; deliveries already recorded for a removed subscription are kept. An environment created in code keeps subscriptions until they are removed this way. |
| Leases | Sources implement `extend`, so the runtime renews leases while a handler runs. |
| Scheduler | Driven by the environment's clock. Each run is reported once, which is stronger than many scheduler services. Runs due while no runtime is subscribed are not backfilled; after a late wake-up the latest due run starts and the earlier ones are recorded as `missed` (at most 10 000 occurrences are examined per wake-up). Cron and daylight-saving rules are those of the [runtime reference](runtime.md#scheduled-runs). |
| Traces | When the runtime passes a trace with a send, write or delete (`DriverOperationContext.trace`: the sending invocation's `correlationId`, its `invocationId` as `causationId`, and the lineage `rootId` and `depth`), the trace is stored with each resulting delivery, kept by redeliveries, duplicates and redrives (unless a redrive starts a new operation), and returned as `LeasedDelivery.trace`, so the receiving invocation joins the trace and lineage. Every delivery also reports `sentAt`, the time it was first stored (or redriven as a new operation), for the runtime's `maxEventAgeMs`. Operations without a trace (signed uploads, the CLI's `queue send`) store none. |
| Not simulated | Network partitions, throttling, service outages and storage quotas. |

## Signed URLs

Local signed URLs are a development implementation. Their security properties:

| Property | Local behaviour |
| --- | --- |
| Signature | HMAC-SHA256 over the method, bucket, key, expiry and, for uploads, the required content type, with a random 256-bit key created on first use and stored in the state directory's database. Deleting the state invalidates every URL; URLs survive restarts that keep it. |
| Scope | One object and one method. `HEAD` is allowed wherever `GET` is. |
| Expiry | Checked against the environment's clock, to the second. |
| Uploads | A `PUT` must send the signed content type when one was required, and at most `maxUploadBytes`. A successful upload stores the object and emits `object.created`, like `put`. |
| Revocation | Not possible: a URL is a bearer token until it expires. |
| Public buckets | Objects in `public-read` buckets can also be read without a signature. |
| Transport | Served by `storage.fetch` on whatever server mounts it, normally plain HTTP on the loopback interface. Do not expose it beyond the developer's machine. |

Bindings for external storage services validate their own signatures and document their own properties.

## Inspection and failure simulation

| API | What it does |
| --- | --- |
| `queues.messages(queueId, states?)` | Lists messages with `messageId`, `state` (`ready`, `delayed`, `in-flight`, `acknowledged`, `dead-lettered`), `attempts`, `schemaVersion`, `payload`, times, the last failure and the sender's `trace`, when one was recorded. |
| `queues.deadLetters(queueId)` | Lists dead-lettered messages. |
| `queues.redrive(queueId, selection?)` | Makes dead-lettered messages due again with a fresh attempt count, oldest first, in one transaction: all of them, the one a message identifier (a string) names, or the ones `{ messageId?, limit?, newOperation? }` selects. Messages keep their trace and lineage unless `newOperation` gives each a new root operation (depth 0, a fresh budget, a new send time, the same correlation). Returns how many. |
| `queues.duplicate(queueId, messageId)` | Delivers a known message once more, with the same message identifier. |
| `queues.purge(queueId)` | Deletes every message that is not in flight. |
| `storage.events(bucketId)` | Lists events with their `trace` (when the writing invocation recorded one and a subscription received the event) and each subscription's delivery `state`, `attempts`, `visibleAt` (when it is due again or its lease ends) and last failure. |
| `storage.objects(bucketId, prefix?)` | Lists stored objects' metadata in key order (UTF-8 bytes). |
| `storage.retainSubscriptions(bucketId, subscriptions)` | Removes the bucket's subscriptions that are not listed, so no further events are recorded for them, and returns the removed identifiers. |
| `storage.redriveEvents(bucketId, subscription, eventId?)`, `storage.duplicateEvent(bucketId, subscription, eventId)` | The same for object events, per subscription. |
| `scheduler.trigger(scheduleId)` | Starts a manual run through the runtime and resolves with its record. Fails with `HOLQA_RUNTIME_NOT_RUNNING` when no runtime receives the schedule. |
| `scheduler.runs(scheduleId, limit?)`, `scheduler.nextRun(scheduleId)` | Recorded runs (`running`, `succeeded`, `failed`, `skipped`, `missed`), newest first, and the next cron run. |
| `settle({ timeoutMs? })` | Waits until no message or event that a runtime receives is due or in flight and no run is in progress. Work waiting for the clock does not count. Fails with `HOLQA_INVOCATION_TIMEOUT` after `timeoutMs` (default 10 000 real milliseconds). |

## Deterministic tests

```ts
import { createLocalEnvironment, ManualClock } from "@holqa/local";
import { createRuntime } from "@holqa/runtime-bun";

const clock = new ManualClock(Date.parse("2026-10-18T09:00:00Z"));
const local = await createLocalEnvironment({ app, directory, clock, env: {} });
const runtime = createRuntime({ app, handlers, binding: local.binding });
await runtime.start();

await resources.jobs.send(job);
await local.settle(); // the first attempt ran and failed
clock.advance(2_000); // the retry becomes due
await local.settle();
expect(local.queues.deadLetters("document-jobs")).toEqual([]);
```

`ManualClock.advance(ms)` moves time continuously: every timer due within the period fires at its own time, in order. `ManualClock.jump(ms)` moves time in one step and then fires due timers late, as after a suspended process, which is how missed schedule runs are produced. `ManualClock.nextTimerDue()` returns when the earliest pending timer is due, so a test can step from timer to timer and settle in between. Handler time limits still use real time.

`createTestApp` in `@holqa/testing` packages this pattern (`flush`, `advance`, `drain`, failure injection, duplicates, inspection and invocation records); see the [local development guide](../guides/local-development.md).

### Invoking background handlers directly

`manualTriggerMetadata(app, definition, { now, createId, attempt?, messageId?, eventId? })` builds the trusted metadata `runtime.invoke` requires for one invocation of a background handler, as if its trigger had fired: a first delivery of a new message (with the queue's `schemaVersion`), a first delivery of a new object event at `now`, or a manual run (`trigger: "manual"`) scheduled at `now`. Nothing is stored, so the invocation does not appear in queue, event or schedule history. HTTP handlers are refused with `HOLQA_OPERATION_INVALID`, because they are invoked with a request; so is an attempt that is not a positive integer. `holqa invoke` and `createTestApp().invoke` use it.

## State format

The state directory has format version 3 (`stateVersion`). Format 2 added the sender's trace to deliveries; format 3 adds their lineage (`root_id`, `depth`) and the `operation_budgets` and `idempotency_keys` tables. Format 1 and 2 directories are upgraded in place when they are opened; their existing deliveries have no lineage, so each starts a new root operation when it is delivered. Opening a directory written by a newer format fails with `HOLQA_LOCAL_STATE_UNSUPPORTED`; after an upgrade, older versions of the local drivers therefore refuse the directory. The format is not a public contract: it can change before 1.0, and inspection should go through the APIs above.

## Related

- [Runtime reference](runtime.md)
- [Event safety](../concepts/event-safety.md)
- [Local development](../concepts/local-development.md)
- [Local development guide](../guides/local-development.md)
- [CLI reference](cli.md)
- [ADR 0024](../architecture/decisions/0024-event-delivery-sources-and-local-drivers.md)
- [Document processing example](../../examples/document-processing/README.md)
