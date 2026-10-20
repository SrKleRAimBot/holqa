# RabbitMQ queues

> **Status:** **Implemented** in `@holqa/rabbitmq` (private, unpublished): a resource provider for the `queue` contract version 1, tested with the reusable queue conformance suite against an in-memory broker and against RabbitMQ 4.

`rabbitmq.queues(options)` binds Holqa queues to RabbitMQ queues through the default exchange.

```ts
import { defineBindings } from "@holqa/bindings";
import { credentialRef } from "@holqa/core";
import { local } from "@holqa/local";
import { rabbitmq } from "@holqa/rabbitmq";
import app from "./infra";

export default defineBindings(app, {
  name: "staging",
  defaults: local.platform(),
  kinds: { queue: rabbitmq.queues({ url: credentialRef("QUEUE_URL"), delayedDelivery: "delay-queues" }) }
});
```

## Storage event channel

`rabbitmq.eventChannel({ url })` carries an object store's S3 event notifications to a storage provider such as `s3.buckets({ events: { channel } })`. Each subscription (one object event handler) reads its own queue `<queuePrefix><bucket>.<handler>` (default prefix `holqa.events.`), which provisioning binds to the exchange the store publishes to (`exchange`, default `holqa.storage-events`, recorded for inspection). Deliveries have the same leases, attempt counts, delay-queue retries (`delayedDelivery`, default `delay-queues`) and dead-letter queue (`deadLetter`, default `true`) as queue messages. Like the queue provider it never creates queues, exchanges or bindings: a missing queue fails with `HOLQA_BINDING_FAILED`.

## Provisioning

`rabbitmq.provisioner({ url: credentialRef("RABBITMQ_ADMIN_URL") })` creates the topology the queue provider and the event channel expect ([provisioning](../provisioning.md)): each queue's main, dead-letter and delay queues with their arguments, and for buckets with `rabbitmq.eventChannel` the notification exchange (`exchangeType`, default `fanout`) and one subscription queue topology per object event handler, bound with `routingKey` (default empty). `providers` limits it to runtime providers with those names, for deployments with several brokers. A queue or exchange that exists with other arguments or type is planned as a destructive `replace`. AMQP 0-9-1 cannot read bindings, so existing ones are planned as idempotent `update`s. The administrative URL is separate from the runtime's `QUEUE_URL`.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `url` | required | A credential reference to the AMQP URL (`amqp://user:password@host:5672/vhost`). A plain string is rejected: URLs carry credentials. |
| `name` | `rabbitmq` | The provider's name. |
| `queues` | none | Broker queue names by Holqa queue identifier. |
| `prefix` | empty | Prepended to Holqa queue identifiers to name broker queues that `queues` does not list. |
| `delayedDelivery` | `none` | `delay-queues` enables the delay emulation (below). With `none`, no delay is advertised, so queues without a binding that can delay fail validation. |
| `deadLetter` | `true` | Use `<queue>.dead-letter`. |
| `queueType` | `quorum` | The queue type provisioning declares for the main and dead-letter queues. |
| `prefetch` | `16` | The most unsettled messages per queue held by one process. |
| `maxAttempts` | `25` | The most attempts a queue may declare. |
| `defaultMaxAttempts` | `5` | Attempts of queues that declare none. |
| `maxMessageBytes` | 16 MiB | The largest serialized envelope accepted (RabbitMQ 4's default `max_message_size`). |
| `connectTimeoutMs` | `10000` | How long starting waits for the broker. |
| `pollIntervalMs` | `1000` | How often an idle receiver checks for work. |

## Topology and permissions

| Broker queue | Purpose | Arguments |
| --- | --- | --- |
| `<queue>` | Messages consumers read. | `x-queue-type` |
| `<queue>.dead-letter` | Dead-lettered messages with their failure. | `x-queue-type` |
| `<queue>.delay.<seconds>` for 1, 2, 5, 10, 30, 60, 120, 300, 600, 900 | Delayed sends and redeliveries (with `delay-queues`). | `x-message-ttl`, `x-dead-letter-exchange: ""`, `x-dead-letter-routing-key: <queue>` |

The provider **never creates or deletes queues**. At start it checks, with passive declarations, that every queue of the topology exists, and fails with `HOLQA_BINDING_FAILED` (naming the missing queues) otherwise. Create the topology with your own tooling or a provisioning step; the runtime's credentials need only `configure` permission for passive declarations, `write` on the queues it publishes to and `read` on those it consumes.

## Semantics

| Behaviour | How |
| --- | --- |
| Delivery | At least once. `send` resolves after the broker confirmed the message (publisher confirms). Messages are persistent. |
| Envelope | The `holqa.message/1` envelope as UTF-8 JSON, `content-type: application/json` with `content-encoding: utf-8`. |
| Metadata | `messageId` property; headers `x-holqa-attempts`, `x-holqa-sent-at`, `x-holqa-trace` (lineage and `traceparent`), and on dead-lettered messages `x-holqa-failure-code`, `-message`, `-attempt`, `-invocation`. |
| Leases | A received message stays unacknowledged while its lease runs. When it expires, a copy with one more attempt is published to the queue and the original acknowledged. Settlements after that, or after the connection dropped, resolve to `false`. `extend` renews the lease. |
| Attempts | Exact across retries and expired leases (the `x-holqa-attempts` header). After a crash or a lost connection the broker redelivers the original: quorum queues report how often (`x-delivery-count`), classic queues only that it happened, so the attempt is then a lower bound. |
| Retries | The runtime decides; the copy goes to the delay queue of the next delay step at least as long as asked, then the original is acknowledged. |
| Dead-lettering | The copy goes to `<queue>.dead-letter` with the failure headers. |
| Order of operations | Copies are published (and confirmed) before the original is acknowledged: a crash in between duplicates a message, never loses it. A failed publish requeues the original. |
| Malformed messages | A message that is not a Holqa envelope is moved to the dead-letter queue with `HOLQA_PAYLOAD_MALFORMED`, or discarded with a warning log when there is none. |
| Reconnection | The client reconnects with backoff and re-creates consumers; unsettled messages return to the queue. `health` is `degraded` while disconnected, and sends fail with `HOLQA_BINDING_UNAVAILABLE`. |
| Backpressure | At most `prefetch` unsettled messages per queue per process; the runtime leases at most its consumer's concurrency. |
| Shutdown | Stopping requeues unsettled deliveries and closes consumers, the publisher and the connection. |
| Ordering | None guaranteed. |

## Emulated capabilities

RabbitMQ has no native delayed delivery. With `delayedDelivery: "delay-queues"` the provider advertises `queue.delay`, `queue.backoff.fixed` and `queue.backoff.exponential` (up to 900 seconds) as **emulations**, which `holqa bindings inspect` reports with their mechanism and the delay queues they need. A delay is rounded **up** to the next step, never down: a 3-second backoff waits 5 seconds. Delay queues hold messages only while they wait; expiry moves them back to the main queue.

## Failures

| Situation | Code |
| --- | --- |
| The broker rejects the login | `HOLQA_BINDING_CREDENTIALS_INVALID` |
| The broker cannot be reached within `connectTimeoutMs` | `HOLQA_BINDING_UNAVAILABLE` |
| A queue of the topology is missing | `HOLQA_BINDING_FAILED` |
| `QUEUE_URL` is not set | `HOLQA_BINDING_CREDENTIALS_MISSING` |
| A send while disconnected | `HOLQA_BINDING_UNAVAILABLE` |

Errors never contain the URL or its password.

## Testing

The package's tests run the queue conformance suite against an in-memory broker on virtual time, and against a real broker when `HOLQA_RABBITMQ_URL` is set (`docker run --rm -p 5672:5672 rabbitmq:4`). CI runs both.
