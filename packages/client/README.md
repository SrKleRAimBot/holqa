# @holqa/client (planned)

> **Status:** Planned. No code exists yet.

The framework-independent runtime used by generated HTTP and RPC clients. It must be safe to import into browser code:
it never exposes private handlers, internal functions, credentials, or secrets.

Boundaries: depends on `@holqa/core` only and must stay runtime-neutral. See
[type safety and schemas](../../docs/concepts/type-safety-and-schemas.md).
