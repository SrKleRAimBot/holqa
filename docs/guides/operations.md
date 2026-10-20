# Operations guide

> **Status:** **Implemented.** Covers `holqa bindings validate`, `holqa provision`, `holqa package`, the container runtime in `@holqa/container`, and the RabbitMQ and S3-compatible providers. The [document processing example](../../examples/document-processing/README.md#three-environments) runs every step against real infrastructure.

How to take an application from a binding configuration to a running deployment, and operate it.

## The pipeline

| Step | Command | Needs | Changes infrastructure |
| --- | --- | --- | --- |
| Check the configuration | `holqa bindings validate --bindings bindings.production.ts` | Nothing; with configuration from the environment, it also checks that credentials are set (names only) | No |
| Test providers | `holqa providers test --tests conformance.ts` | The providers' credentials | Only what the harnesses create |
| Plan infrastructure | `holqa provision plan --provisioning provisioning.ts` | Administrative credentials | No (reads only) |
| Apply infrastructure | `holqa provision apply` (`--allow-destructive` only after review) | Administrative credentials | Yes |
| Package | `holqa package --bindings bindings.production.ts` | Nothing | No |
| Run | `bun server.js` in the artifact, or its Dockerfile | Runtime credentials | No |

Provisioning is optional: infrastructure created by other tools is equally valid, as long as names match what the runtime providers expect (`holqa bindings inspect` shows the settings).

## Credentials

| Credential | Used by | Where it comes from |
| --- | --- | --- |
| Runtime (for example `QUEUE_URL`, `S3_ACCESS_KEY_ID`) | The running application | The configuration services of the binding: environment variables, mounted secret files (`container.secretFiles()`, default `/run/secrets`), or both in order |
| Administrative (for example `RABBITMQ_ADMIN_URL`) | `holqa provision` only | The environment of the command |

Grant runtime credentials data-plane permissions only: for RabbitMQ, `configure` for passive declarations plus `read` and `write` on the application's queues; for S3, `HeadBucket`, `GetObject`, `PutObject`, `DeleteObject` and `ListBucket` on its buckets. `bindings.json` in the artifact lists every credential name the application reads.

Rotation: secret files are read again when a configuration service is refreshed, so a rotated value reaches credentials resolved afterwards (for example on reconnect). Configuration entries already validated at start keep their values until the process restarts; restart replicas one at a time to apply them.

## Running the container

The artifact runs with `bun server.js` in its directory; the reference Dockerfile does exactly that on the official Bun image as an unprivileged user.

| Concern | Behaviour |
| --- | --- |
| Settings | `PORT` (default 3000), `HOST` (default `0.0.0.0`), `HOLQA_SHUTDOWN_GRACE_MS` (10 000), `HOLQA_SHUTDOWN_FORCE_MS` (1 000), `HOLQA_MAX_REQUEST_BODY_BYTES` (1 MiB). |
| Liveness | `GET /.holqa/live` answers `200` while the process serves, including while it drains. |
| Readiness | `GET /.holqa/ready` answers `200` only while the runtime runs and no provider is unhealthy (for example while RabbitMQ is reconnecting it is `degraded`, still ready; a failed component makes it `503`). Route traffic on readiness. |
| Start-up failures | One JSON line on standard error (`container failed to start`, with diagnostics and no credential values) and exit status `1`. Common causes: `HOLQA_BINDING_CREDENTIALS_MISSING`, `HOLQA_BINDING_FAILED` (missing queue or bucket: provision first), `HOLQA_ARTIFACT_INVALID` (altered artifact, or a binding that differs from the packaged one: package again). |
| Shutdown | `SIGTERM` or `SIGINT`: new requests get `503`, in-flight invocations get the grace period, consumers stop and return unsettled deliveries to their queues, providers stop in reverse order, exit status `0`. Set the platform's grace period above `HOLQA_SHUTDOWN_GRACE_MS + HOLQA_SHUTDOWN_FORCE_MS`. |
| Logs | JSON lines on standard output, with invocation, correlation, causation and trace identifiers. Secrets are redacted. |
| Telemetry | With `otlp.telemetry`, spans and metrics go to the OTLP receiver in a bounded background pipeline; a receiver that is down loses batches, never requests. |

## Replicas

Declare the replica count in the binding configuration (`replicas`), so validation can check it: schedules, queues, buckets and event safety stores must keep their state where every replica reaches it. `container.schedules()` and the local platform keep state in one process and are rejected for more than one replica; run schedules on one replica's configuration or on an external scheduler. RabbitMQ queues and S3-compatible buckets are shared, so replicas share work: each delivery is leased by one replica at a time.

## Delivery semantics to plan for

| Topic | What to expect |
| --- | --- |
| Duplicates | Delivery is at least once everywhere: after a crash or a lost connection, a message or object event can arrive again. Handlers must be idempotent (the example skips results it already wrote). |
| Retries | Retries and delays follow the queue's declared backoff. With RabbitMQ, delays are rounded up to the next delay-queue step (1, 2, 5, 10, 30, 60, 120, 300, 600 or 900 seconds). |
| Dead letters | Exhausted messages go to `<queue>.dead-letter` with the failure code, message and attempt in headers; malformed messages go there with `HOLQA_PAYLOAD_MALFORMED`. |
| Object events | Arrive only when the store is configured to publish notifications to the event channel. Notifications of other buckets, types or prefixes are acknowledged and skipped. |
| Lineage | Continues from the writer of an object to its event handler when the store includes user metadata in notifications (MinIO and RustFS do, AWS S3 does not). |
| Ordering | Not guaranteed by any provider. |

## Troubleshooting

| Symptom | Check |
| --- | --- |
| A handler of a queue or bucket never runs | `holqa bindings validate`: a provider with `delivery: "none"` or a request-driven host is reported as `HOLQA_BINDING_TOPOLOGY_UNSUPPORTED`. For object events, check the bucket's notification rule (`holqa provision plan` shows it) and that the subscription queue is bound to the exchange. |
| Readiness stays `503` | `GET /.holqa/ready` lists every component's status and message. |
| Messages pile up in a dead-letter queue | The header `x-holqa-failure-code` names the failure; logs carry the same invocation identifier. |
| The container refuses to start after a configuration change | The binding manifest is fixed at packaging. Package again for the new configuration. |

## Related

- [Container runtime](../reference/container.md)
- [Provisioning](../reference/provisioning.md)
- [RabbitMQ](../reference/providers/rabbitmq.md), [S3-compatible storage](../reference/providers/s3.md)
- [Migrating to binding configurations](migrating-to-bindings.md)
