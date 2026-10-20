---
"@holqa/rabbitmq": minor
---

Add `@holqa/rabbitmq`, a RabbitMQ queue provider: `rabbitmq.queues({ url: credentialRef(...) })` with publisher confirms, leased deliveries, exact attempt counts across retries and expired leases, retries and delayed sends through an explicitly enabled delay-queue emulation (rounded up, never earlier), a dead-letter queue with failure headers, quarantine of malformed messages, reconnection, prefetch-bounded backpressure and graceful shutdown. It checks that its topology exists and never creates queues. Failures are classified (invalid credentials, unavailable, missing topology). It passes the queue conformance suite against an in-memory broker and against RabbitMQ 4.
