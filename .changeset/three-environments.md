---
"@holqa/cli": patch
"@holqa/rabbitmq": patch
"@holqa/s3": minor
---

`examples/document-processing` runs the same handlers in three environments (local; a Bun container on RabbitMQ and an S3-compatible store with OTLP telemetry; mixed providers with secret files), verified end to end against real infrastructure, with a Docker Compose demonstration. `s3.provisioner` accepts `endpoint`, for provisioning from outside the application's network. `@holqa/rabbitmq` and `@holqa/s3` now build `dist/index.js`, which their `exports` name; they built `index.mjs` before, so their built packages could not be imported. `holqa provision apply` says "Nothing was applied." when a plan error prevented applying.
