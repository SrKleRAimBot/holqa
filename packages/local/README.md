# @holqa/local

> **Status:** Implemented (local binding). Private; not published. `holqa dev` and the other local CLI commands are proposed, not implemented.

Runs an application's queues, buckets and schedules on one machine, without cloud credentials. `@holqa/local` is a
runtime binding: it implements the same driver and source contracts as any other binding, so handler code does not
change, and `@holqa/runtime-bun` applies the same delivery policy (retries, backoff, dead-lettering, concurrency) to it.

```ts
import { createLocalEnvironment } from "@holqa/local";
import { createRuntime, loadCompiledApplication } from "@holqa/runtime-bun";

const compiled = await loadCompiledApplication({ root: import.meta.dir });
const local = await createLocalEnvironment({ app: compiled.app, directory: ".holqa/local" });
const runtime = createRuntime({ ...compiled, binding: local.binding });
await runtime.start();
```

| Part | What it does |
| --- | --- |
| Queues | `holqa.message/1` envelopes in SQLite (`bun:sqlite`) with leases, delays, retries and a dead-letter state; inspection, redrive and duplicate delivery. |
| Buckets | Object bytes in files named by a hash of the key, metadata in SQLite, `object.created` and `object.deleted` events per subscription, bounded listings, development signed URLs served by `storage.fetch`. |
| Scheduler | Cron runs driven by an injectable `Clock`, records of every run (including missed ones) and manual runs. |
| Testing | `ManualClock` (`advance`, `jump`) and `settle()` make delivery, retries, expiry and schedules deterministic. |

The binding advertises only what common production services also offer (for example at most 900 seconds of delay),
so an application that runs locally does not depend on stronger guarantees. Local signed URLs are a development
implementation; their security properties are listed in the reference.

See the [local environment reference](../../docs/reference/local.md), the [runtime reference](../../docs/reference/runtime.md#queue-delivery),
[ADR 0024](../../docs/architecture/decisions/0024-event-delivery-sources-and-local-drivers.md) and the
[document-processing example](../../examples/document-processing/README.md).

Boundaries: depends on `@holqa/core` and `@holqa/runtime-bun`. Runs on Bun only. Its tests use hand-built
descriptors; end-to-end tests with the SDK live in the examples.
