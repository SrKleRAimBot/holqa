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

## Binding providers

The same local state is also available as binding providers, for binding configurations ([binding contracts](bindings.md#binding-configurations)):

```ts
import { defineBindings } from "@holqa/bindings";
import { local, localEnvironment } from "@holqa/local";
import app from "./infra";

// Everything local, persisted in .holqa/local:
export default defineBindings(app, { name: "local", defaults: local.platform() });

// Or share one state between the platform and per-kind providers:
const env = localEnvironment({ persistence: "sqlite", directory: ".holqa/local" });
// defineBindings(app, { defaults: env.platform(), resources: { "audit-log": env.queues() } });
```

| Factory | Provider | Role | Binds |
| --- | --- | --- | --- |
| `local.platform(options?)`, `env.platform()` | `holqa.local`, named `local` | `platform` | Every resource kind; the `execution` (Bun, long-running), `config` (environment variables or `options.env`), `telemetry` (the local telemetry store), `idempotency` and `operation-budgets` services. |
| `local.queues(options?)`, `env.queues()` | `holqa.local`, named `local.queues` | `resource` | Queues. |
| `local.buckets(options?)`, `env.buckets()` | `holqa.local`, named `local.buckets` | `resource` | Buckets and object events. |
| `local.schedules(options?)`, `env.schedules()` | `holqa.local`, named `local.schedules` | `resource` | Schedules. |

| Option | Default | Meaning |
| --- | --- | --- |
| `persistence` | `sqlite` | `sqlite`: state in `directory` (a `state.sqlite` database and `objects/` files), kept across restarts, shared by processes on the host. `memory`: everything in the process, lost when the binding stops; for fast, isolated tests. **Memory state is not durable** and must never stand in for production durability. |
| `directory` | `.holqa/local` | Where `sqlite` state is kept, relative to the working directory. |
| `name` | `local` | The platform's name; per-kind providers append `.queues`, `.buckets`, `.schedules`. |
| `env` | `process.env` | Configuration values and credentials. Without it, `settings.configSource` is `environment`, so `holqa bindings validate` checks that values are set. |
| `clock`, `createId`, `queues`, `storage` | as for `createLocalEnvironment` | |
| `telemetry` | `true` | Whether the platform supplies the local telemetry store as its telemetry exporter. |

Creating a provider opens nothing and validates the options (`HOLQA_BINDING_CONFIG_INVALID`). Providers from one `localEnvironment` share one state: the first to be opened opens it, the last to stop closes it, and opening it for a second application fails with `HOLQA_BINDING_CONFIG_INVALID`. `env.state()` returns the opened state for inspection (`queues`, `storage`, `scheduler`, `settle`, `telemetry`) while any of them is open. Their topology is `{ delivery: "pull", state: "host" }` (`sqlite`) or `state: "process"` (`memory`): deliveries need a long-running process, and state is not shared beyond one host.

`createLocalEnvironment` and the providers run on the same engine (`openLocalState`), and both pass the reusable conformance suite in `@holqa/conformance` in both persistence modes.

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

## Static sites

The local binding serves static sites from files: `<root>/<directory>`, where `root` is the application root (`createLocalEnvironment({ root })`, `local.platform({ root })`, `createTestApp({ root })`; default the working directory; `holqa dev` passes the application module's directory). It refuses any path that leaves the site's directory (including encoded `..` and NUL), serves a directory's `index.html`, falls back to the root `index.html` for unknown extension-less paths when the site sets `spa: true`, derives content types from file extensions, and sends HTML with `cache-control: no-cache`. It advertises `static.site: { spaFallback: true }`.

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
| `queues.redrive(queueId, selection?)` | Makes dead-lettered messages due again with a fresh attempt count, oldest first, in one transaction: all of them, the one a message identifier (a string) names, or the ones `{ messageId?, limit?, newOperation? }` selects. Messages keep their trace and lineage unless `newOperation` gives each a new root operation (depth 0, a fresh budget, a new send time, the same correlation) and a new telemetry trace (the stored `traceparent` is cleared). Returns how many. |
| `queues.duplicate(queueId, messageId)` | Delivers a known message once more, with the same message identifier. |
| `queues.purge(queueId)` | Deletes every message that is not in flight. |
| `storage.events(bucketId)` | Lists events with their `trace` (when the writing invocation recorded one and a subscription received the event) and each subscription's delivery `state`, `attempts`, `visibleAt` (when it is due again or its lease ends) and last failure. |
| `storage.objects(bucketId, prefix?)` | Lists stored objects' metadata in key order (UTF-8 bytes). |
| `storage.retainSubscriptions(bucketId, subscriptions)` | Removes the bucket's subscriptions that are not listed, so no further events are recorded for them, and returns the removed identifiers. |
| `storage.redriveEvents(bucketId, subscription, eventId?)`, `storage.duplicateEvent(bucketId, subscription, eventId)` | The same for object events, per subscription. |
| `scheduler.trigger(scheduleId)` | Starts a manual run through the runtime and resolves with its record. Fails with `HOLQA_RUNTIME_NOT_RUNNING` when no runtime receives the schedule. |
| `scheduler.runs(scheduleId, limit?)`, `scheduler.nextRun(scheduleId)` | Recorded runs (`running`, `succeeded`, `failed`, `skipped`, `missed`), newest first, and the next cron run. |
| `binding.sources.queue(resource).pending()` | Counts a queue's messages that are ready, delayed or in flight (`QueueSource.pending`); the runtime reports it as the `holqa.queue.pending` metric. |
| `readDeliveryHistory(directory, id)` | Reads, read-only and without an environment, what the state records about one message or object event: one `DeliveryRecord` per channel (`kind`, `resourceId`, `subscription`, `state`, `attempts`, times, `lastError`, `trace` with lineage and `traceparent`) and, for an object event, its bucket, type, key and time. `undefined` when nothing has the identifier or the directory has no state. `holqa events inspect` uses it. |
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

## Telemetry store

`createLocalTelemetryStore({ directory, retention?, clock? })` opens `telemetry.sqlite` in a state directory: a bounded store of recent spans, log entries and metric series, separate from the resource state, that `holqa logs`, `holqa traces`, `holqa events inspect` and `holqa metrics` read. Several processes may write to it.

```ts
import { createLocalTelemetryStore } from "@holqa/local";

const store = createLocalTelemetryStore({ directory: ".holqa/local" });
const runtime = createRuntime({ app, handlers, binding: local.binding, log: store.writeLog, telemetry: { exporters: [store.exporter] } });
```

| API | What it does |
| --- | --- |
| `exporter` | A `TelemetryExporter` named `local` that stores spans and the latest point of every metric series, per runtime instance (`service.instance.id`), writing asynchronously. |
| `writeLog(entry)` | Queues one runtime log entry; use it from a log sink. Entries are written in batches every 200 ms, off the caller's stack. At most 2 048 entries wait; further ones are dropped and reported on standard error at most once a minute. |
| `flushLogs()` | Writes the queued log entries now. |
| `increment(metric, attributes?, by?)` | Adds to a counter reported by a process outside a runtime, in an immediate transaction; the dev session counts `holqa.dev.reload.failures` this way. |
| `logs({ after?, limit?, level?, handlerId?, traceId?, correlationId?, deliveryId? })` | Log entries with their position (`seq`), oldest first: the newest `limit` (default 100), or those after a position. |
| `traces(limit?)` | The most recent traces (default 20), newest first: `traceId`, root span name, start, duration, span count, errors. |
| `trace(traceId)`, `matchTraceIds(prefix)` | One trace's spans by start time; the stored trace identifiers starting with a prefix (at most two). |
| `spansOfDelivery(id)` | The spans that processed or published one message or object event. |
| `metrics()` | Framework metrics, aggregated per name and type: counters and histograms of the instances that reported them are added up (histograms only when their bucket boundaries are equal); gauges come from the latest report. |
| `close()` | Writes the queued log entries and closes the store. |

Retention (`retention`): at most `maxSpans` spans (default 20 000) and `maxLogs` log entries (default 20 000), and nothing older than `maxAgeMs` (default 24 hours), enforced every 200 writes. Invalid settings fail with `HOLQA_DECLARATION_INVALID`. `openLocalTelemetryReader(directory)` opens the same queries read-only, or returns `undefined` when nothing was recorded yet. Rows that cannot be read (damaged or written by something else) are skipped. The store has its own format (`telemetryStoreVersion`, 1); a newer format fails with `HOLQA_LOCAL_STATE_UNSUPPORTED`, for writers and readers alike, and the file can be deleted at any time. The store waits at most 100 ms for a lock: a batch that cannot get it is dropped rather than slowing the application down.

## State format

The state directory has format version 4 (`stateVersion`). Format 2 added the sender's trace to deliveries; format 3 added their lineage (`root_id`, `depth`) and the `operation_budgets` and `idempotency_keys` tables; format 4 adds the publishing span's telemetry context (`traceparent`). Format 1 to 3 directories are upgraded in place when they are opened; deliveries written before format 3 have no lineage, so each starts a new root operation when it is delivered, and deliveries written before format 4 start a new telemetry trace. Opening a directory written by a newer format fails with `HOLQA_LOCAL_STATE_UNSUPPORTED`; after an upgrade, older versions of the local drivers therefore refuse the directory. The format is not a public contract: it can change before 1.0, and inspection should go through the APIs above.

## Related

- [Runtime reference](runtime.md)
- [Event safety](../concepts/event-safety.md)
- [Observability](../concepts/observability.md)
- [Local development](../concepts/local-development.md)
- [Local development guide](../guides/local-development.md)
- [CLI reference](cli.md)
- [ADR 0024](../architecture/decisions/0024-event-delivery-sources-and-local-drivers.md)
- [Document processing example](../../examples/document-processing/README.md)
