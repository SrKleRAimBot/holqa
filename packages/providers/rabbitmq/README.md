# @holqa/rabbitmq

A RabbitMQ binding provider for Holqa queues: publisher confirms, leased deliveries, exact attempt counts, retries
through explicitly enabled delay queues, dead-lettering, reconnection and backpressure.

> **Status:** Implemented, private and unpublished. The API may change before the first release.

```ts
rabbitmq.queues({ url: credentialRef("QUEUE_URL"), delayedDelivery: "delay-queues" });
```

The provider never creates queues: provision the topology first. It depends on `@holqa/core` and `rabbitmq-client`
(no transitive dependencies). See the [RabbitMQ provider reference](../../../docs/reference/providers/rabbitmq.md).
