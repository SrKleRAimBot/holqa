# Integrations

> **Status:** `zod` (`@holqa/zod`) is **Implemented**. The other directories describe planned integration packages and
> contain only a README. Their final npm package names have not been decided.

| Directory | Purpose |
| --- | --- |
| [zod](zod) | **Implemented.** Zod 4 schema adapter for portable, verified schema contracts. |
| [valibot](valibot) | Schema adapter for Valibot. |
| [effect](effect) | Effect Schema adapter and Effect-based handlers. |
| [orpc](orpc) | Interoperability with existing oRPC routers and contracts. |
| [tanstack-query](tanstack-query) | Typed query and mutation options and query keys for generated clients. |

Integration packages depend inward on `@holqa/core`, `@holqa/sdk`, and `@holqa/client`, never the reverse. See
[docs/integrations/index.md](../../docs/integrations/index.md).
