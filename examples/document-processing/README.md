# Document processing example

> **Status:** **Implemented.** Executed by `pnpm test` and `pnpm check` (and therefore CI).

A private workspace package and the reference application for event-driven resources. It is written with
`@holqa/sdk` and Zod, compiled by the **built** `holqa` binary, and runs entirely on this machine with the
`@holqa/local` binding and `@holqa/runtime-bun`. See the [runtime reference](../../docs/reference/runtime.md#queue-delivery)
and the [local environment reference](../../docs/reference/local.md).

```mermaid
flowchart LR
  C[Client] -- "POST /api/documents" --> A[documents.accept]
  A -- signed PUT URL --> C
  C -- PUT bytes --> B[(document-files)]
  B -- object.created --> U[uploads.queue]
  U -- send --> Q[[document-jobs]]
  Q --> P[documents.process]
  P -- results/… --> B
  S((upload-cleanup<br/>hourly)) --> X[uploads.cleanup]
  X -- delete expired uploads --> B
  B -- object.deleted --> E[uploads.expired]
```

| File | What it shows |
| --- | --- |
| [`app/infra.ts`](app/infra.ts) | An `http.api`, a private bucket, a queue with three attempts, exponential backoff and a dead-letter requirement, an hourly schedule with `overlap: "skip"`, and a configuration variable. |
| [`app/src/documents.handler.ts`](app/src/documents.handler.ts) | Validates upload metadata, records the document and returns a signed `PUT` URL; reports a document's status and result. |
| [`app/src/uploads.handler.ts`](app/src/uploads.handler.ts) | `onObjectCreated` turns each upload into a queue job; `onObjectDeleted` records removed uploads. Both tolerate duplicate events. |
| [`app/src/processor.handler.ts`](app/src/processor.handler.ts) | The queue consumer: idempotent by upload `etag`; `#fail-once` fails the first attempt and `#poison` fails every attempt, for the demo. |
| [`app/src/cleanup.handler.ts`](app/src/cleanup.handler.ts) | The schedule handler: pages through `uploads/` and deletes uploads older than `UPLOAD_TTL_HOURS`, measured from the run's scheduled time. |
| [`app/server.ts`](app/server.ts) | Serves the API and the local signed URLs from one `Bun.serve` server, with state in `.holqa/local`. |

| Test ([`tests/document-processing.test.ts`](tests/document-processing.test.ts)) | Asserts |
| --- | --- |
| Upload to result | Over real HTTP: the upload is accepted, stored through its signed URL, reported as a `holqa.object-event/1` event, queued as a versioned job and processed in the background. |
| Validation | Invalid metadata answers `400 HOLQA_INPUT_INVALID` with per-field issues; a wrong content type or an expired URL answers `403 HOLQA_SIGNED_URL_INVALID`. |
| Retry | A failing first attempt is retried after the 2-second backoff and succeeds on attempt 2. |
| Dead letter | A job that fails all three attempts is dead-lettered with its payload, failure code and invocation identifier, which the logs also carry; it can be redriven. |
| Duplicates | A duplicated storage event queues a second job that the processor recognizes and skips. |
| Cleanup | Hourly runs remove the upload once it is older than 24 hours, the deletion event updates the record, results are kept, and a manual run is recorded too. |

Time is controlled with `ManualClock`, so retries, URL expiry and schedules are deterministic.

```bash
pnpm turbo run test --filter=@holqa/example-document-processing
# or run it (after `pnpm build`): builds the manifest, then serves on PORT (default 3000)
pnpm --filter @holqa/example-document-processing start
curl -X POST 127.0.0.1:3000/api/documents -H 'content-type: application/json' -d '{"fileName":"notes.txt","contentType":"text/plain","size":11}'
# PUT the file to the returned upload.url with the returned headers, then:
curl 127.0.0.1:3000/api/documents/<documentId>
```

The application also runs under the development supervisor, which rebuilds and restarts it when a file changes and keeps its local state in `app/.holqa/local` (see the [local development guide](../../docs/guides/local-development.md)):

```bash
cd examples/document-processing
pnpm exec holqa dev --app app/infra.ts
pnpm exec holqa state --app app/infra.ts   # in another terminal
```

## Three environments

The same handlers run in three environments; only the binding configuration changes. The configurations are in
[`app/environments.ts`](app/environments.ts); no handler mentions an infrastructure provider.

| Environment | Binding | Compute | Queues | Files and object events | Schedules | Configuration | Telemetry |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A: local | [`app/bindings.ts`](app/bindings.ts) | Local platform | Local | Local | Local | Environment | Local store |
| B: external | [`app/bindings.external.ts`](app/bindings.external.ts) | Bun container (`container.host()`) | RabbitMQ | S3-compatible store; notifications through RabbitMQ | In the container (`container.schedules()`) | Environment | OTLP receiver |
| C: mixed | `mixedBindings(...)` | Local platform | RabbitMQ | S3-compatible store; notifications through RabbitMQ | Local platform | Secret files, then environment | OTLP receiver |

[`tests/environments.test.ts`](tests/environments.test.ts) checks A always. With `HOLQA_RABBITMQ_URL`, `HOLQA_S3_ENDPOINT`,
`HOLQA_S3_ACCESS_KEY_ID`, `HOLQA_S3_SECRET_ACCESS_KEY` and `HOLQA_S3_EVENTS_TARGET` set (as in CI's provider job), it
also provisions uniquely named infrastructure and processes a document end to end in B and C: upload through a
presigned URL, the store's notification through RabbitMQ, the object event handler, the queue consumer and the result,
with traces exported over OTLP. It removes what it created.

### Environment B with Docker Compose

[`compose.yaml`](compose.yaml) runs RabbitMQ, RustFS (publishing bucket notifications to RabbitMQ), an OpenTelemetry
Collector, and the packaged application. From this directory, after `pnpm build` at the repository root:

```bash
cp .env.example .env                       # then choose your own values
docker compose up -d rabbitmq object-store collector
set -a; . ./.env; set +a
export RABBITMQ_ADMIN_URL="amqp://$RABBITMQ_USER:$RABBITMQ_PASSWORD@localhost:25672"
export S3_ADMIN_ACCESS_KEY_ID="$S3_ACCESS_KEY_ID" S3_ADMIN_SECRET_ACCESS_KEY="$S3_SECRET_ACCESS_KEY"
pnpm exec holqa provision plan --app app/infra.ts    # reads only
pnpm exec holqa provision apply --app app/infra.ts   # queues, exchange, bucket, notification rule
pnpm exec holqa package --app app/infra.ts --bindings app/bindings.external.ts --out-dir .holqa/package/external
docker compose up -d --build app
docker compose --profile demo run --rm client      # uploads a document and waits until it is processed
docker compose --profile demo down -v
```

[`app/provisioning.ts`](app/provisioning.ts) reaches the store on its published port; the application reaches it as
`object-store:9000` inside the network, which is why the client runs there too. The application's credentials
(`QUEUE_URL`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`) are references resolved from its environment; the binding
manifest in the artifact lists their names only.

