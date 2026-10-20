---
"@holqa/bindings": minor
"@holqa/cli": patch
"@holqa/container": minor
"@holqa/opentelemetry": minor
"@holqa/s3": patch
---

Add the providers hybrid deployments compose. `otlp.telemetry({ endpoint, headers })` in `@holqa/opentelemetry` selects the telemetry destination per environment, with header values as credential references. `container.secretFiles()` reads configuration and secrets from files (default `/run/secrets`) with refresh for rotation, and `container.schedules()` is an in-process scheduler for containers. Binding configurations accept `replicas`, recorded in the binding report and manifest; `validateBindings` rejects schedules, queues, buckets and event safety stores whose state lives in one process when more than one replica runs (`HOLQA_BINDING_TOPOLOGY_UNSUPPORTED`), and warns for state on one machine. `@holqa/s3` reads the writer's trace from notifications that name user metadata without the `X-Amz-Meta-` prefix, as RustFS does.
