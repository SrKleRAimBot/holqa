# @holqa/sdk (planned)

> **Status:** Planned. No code exists yet; this directory holds the package's intended scope.

The primary developer-facing SDK: `defineApp`, resource constructors (`http.api`, `queue`, `bucket`, `schedule`,
`staticSite`), configuration helpers (`secret`, `variable`), and typed resource handles such as
`resources.orders.send()` and `resources.orders.consume()`.

Boundaries: depends only on `@holqa/core`. It must stay runtime-neutral and must never import compiler internals,
runtime drivers, or provider code. See [the application model](../../docs/concepts/application-model.md) and
[package boundaries](../../docs/architecture/package-boundaries.md).
