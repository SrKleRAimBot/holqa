# @holqa/local (planned)

> **Status:** Planned. No code exists yet.

Local execution and resource emulation: an in-process queue emulator, filesystem-backed object storage, a local
scheduler, event inspection, and failure injection (duplicate deliveries, retries) for deterministic testing. The local
environment must never promise stronger delivery or concurrency guarantees than production providers.

Boundaries: may depend on `@holqa/core` and `@holqa/runtime-bun`. See
[local development](../../docs/concepts/local-development.md).
