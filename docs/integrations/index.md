# Integrations

> **Status:** Planned. No integration packages exist yet. This section records the intended integration patterns so that core packages are designed to support them.

Holqa must be composable. It should not require developers to abandon the frameworks and libraries they already use. Integrations are adapters that connect those libraries to Holqa's resource graph, schemas, handlers, and generated clients.

## Integration categories

| Category | Examples | Purpose | Status | Page |
| --- | --- | --- | --- | --- |
| Schema adapters | Zod, Valibot, Effect Schema | Turn library schemas into Standard Schema plus Holqa's normalized representation. | Planned (Zod first) | [Schema libraries](schema-libraries.md) |
| Handler adapters | Native async functions, Effect | Let handlers be written as async functions or as Effect programs. | Planned | [Effect](effect.md) |
| HTTP/transport adapters | Hono, oRPC, Effect HTTP | Mount existing HTTP and RPC frameworks as implementations of Holqa HTTP resources. | Planned | [oRPC and Hono](orpc-and-hono.md), [Effect](effect.md) |
| Frontend client adapters | Fetch API, TanStack Query | Call public contracts from browsers with full types. | Planned | [TanStack](tanstack.md) |
| Application adapters | Vite, TanStack Start | Frontend development, static builds, full-stack hosting. | Planned (TanStack Start: future) | [Vite](vite.md), [TanStack](tanstack.md) |
| Data access | Drizzle, Prisma, native PostgreSQL clients | Use existing data libraries with Holqa-managed configuration. | Planned | [Drizzle and databases](drizzle-and-databases.md) |
| Observability | OpenTelemetry | Traces and metrics for handler invocations and resource operations. | Planned | — |

## Principles

| Principle | Consequence |
| --- | --- |
| Integrate, do not replace. | Holqa will not ship its own HTTP framework, ORM, or router to compete with established libraries. |
| No proprietary SQL layer. | Drizzle, Prisma, and native clients own data access. |
| No single HTTP framework required. | Native Fetch handlers, Hono, and oRPC are all valid. |
| Generated clients are browser-safe. | They never contain private handlers, internal functions, credentials, or secrets. |
| TanStack Router keeps routing. | Holqa does not take over frontend routing. |
| TanStack Start is a future integration. | It is not an initial requirement. |
| Vite owns frontend development. | Holqa reuses Vite's dev server and HMR instead of building its own. |
| No Convex-style reactivity promise. | Holqa will not promise automatic database reactivity without the underlying change-tracking infrastructure. |
| Integrations depend inward. | Integration packages may depend on `@holqa/core`, `@holqa/sdk`, and `@holqa/client` only; core packages never depend on integrations. |

## Packaging

Planned integration packages live under `packages/integrations/`:

| Directory | Purpose |
| --- | --- |
| `packages/integrations/zod` | Zod schema adapter. |
| `packages/integrations/valibot` | Valibot schema adapter. |
| `packages/integrations/effect` | Effect handlers, Effect Schema, Effect HTTP. |
| `packages/integrations/orpc` | oRPC interoperability. |
| `packages/integrations/tanstack-query` | TanStack Query options and keys. |

Final npm names (for example `@holqa/zod` vs. `@holqa/schema-zod`) are not decided. The allowed dependency directions are already enforced by `scripts/check-boundaries.ts`; see [package boundaries](../architecture/package-boundaries.md).

Each integration should:

- Keep its third-party library as a peer dependency where possible, so applications control the version.
- Contain no logic that core packages need; if core needs something, it belongs in core as a neutral contract.
- Have its own tests and documentation page in this directory.

## Related

- [Type safety and schemas](../concepts/type-safety-and-schemas.md)
- [Triggers and execution](../concepts/triggers-and-execution.md)
- [Roadmap, Phase 4](../roadmap.md#phase-4-clients-and-integrations)
