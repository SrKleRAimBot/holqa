---
"@holqa/core": minor
"@holqa/rabbitmq": minor
"@holqa/s3": minor
---

Add `@holqa/s3`, an S3-compatible bucket provider: `s3.buckets({ endpoint, accessKeyId: credentialRef(...), secretAccessKey: credentialRef(...) })` with SigV4-signed object writes, reads, metadata, deletion, paged listing and presigned URLs over `fetch` (no SDK). It checks that its buckets exist and never creates them. Object events come from S3 event notifications delivered through an event channel, so storage and notifications stay separate: `@holqa/core` gains the `EventChannel` and `OpenedEventChannel` types, and `@holqa/rabbitmq` gains `rabbitmq.eventChannel` and the generic `createLeasedBinding`. Events have stable identifiers across redeliveries, and the writer's trace continues when the store includes user metadata in notifications. It passes the bucket and bucket events conformance suites against an in-memory store and the bucket suite against a real S3-compatible store.
