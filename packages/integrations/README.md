# Integrations (planned)

> **Status:** Planned. These directories describe intended integration packages; none contain code yet. Final npm
> package names have not been decided.

| Directory | Purpose |
| --- | --- |
| [zod](zod) | First-class Standard Schema adapter and portable schema normalization for Zod. |
| [valibot](valibot) | Schema adapter for Valibot. |
| [effect](effect) | Effect Schema adapter and Effect-based handlers. |
| [orpc](orpc) | Interoperability with existing oRPC routers and contracts. |
| [tanstack-query](tanstack-query) | Typed query and mutation options and query keys for generated clients. |

Integration packages depend inward on `@holqa/core`, `@holqa/sdk`, and `@holqa/client`, never the reverse. See
[docs/integrations/index.md](../../docs/integrations/index.md).
