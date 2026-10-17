---
name: framework-integration
description: Design rules for integrating Holqa with existing TypeScript libraries - Zod, Valibot, Effect, oRPC, Hono, TanStack Query/Router/Start, Vite, Drizzle, Prisma, and OpenTelemetry. Covers dependency direction (integrations depend inward on core/sdk/client), thin adapters instead of forks or replacements, peer dependencies, browser-safe generated clients, and honest Planned labeling. Use when proposing, designing, documenting, or scaffolding anything under packages/integrations/, or when a change touches how Holqa interoperates with another framework.
---

# Framework integration

## Purpose

Holqa must compose with the TypeScript ecosystem rather than replace it. Every integration is **Planned**: no integration package exists yet (`packages/integrations/{zod,valibot,effect,orpc,tanstack-query}` contain READMEs only, and final npm names are undecided). This skill sets the rules for designing them so they stay thin, optional, and correctly layered.

## When to use

- Writing design docs or ADRs for an integration.
- Creating the first real package under `packages/integrations/`.
- Reviewing a change that adds a third-party framework dependency anywhere.
- Documenting how Holqa is intended to work with another library.

## Principles

1. **Depend inward.** Integrations may depend on `@holqa/core`, `@holqa/sdk`, and `@holqa/client` only (enforced by `scripts/check-boundaries.ts`). Core, SDK, and client never import an integration or a third-party framework.
2. **Adapters, not forks.** Wrap the library's public API. Do not vendor, re-implement, or monkey-patch it. If the library already does something (routing, query caching, SQL), defer to it.
3. **Optional and peer-based.** The host library is a `peerDependency` (with a matching `devDependency` via `catalog:` for tests). Users install it themselves; Holqa never bundles it.
4. **Browser-safe clients.** Anything that can be imported by frontend code (generated clients, TanStack Query helpers) must not import server code, handlers, secrets, `bun`, `bun:*`, or `node:*`, and must expose only public contracts.
5. **Standards first.** Prefer Standard Schema, the Fetch API (`Request`/`Response`), and Web streams as the meeting points, so one adapter serves many libraries.
6. **Explicit capability gaps.** If a library feature cannot map to a Holqa contract, emit a diagnostic or document the limitation; do not approximate silently.
7. **Honest status.** Every doc and README describes integrations as Planned (or Proposed once designed) until code and tests exist.

## Integration map (all Planned)

| Library | Category | Intended shape | Must not |
| --- | --- | --- | --- |
| Zod | Schema adapter (first-class) | Standard Schema input; normalization to the portable representation, JSON Schema where faithful | Leak Zod types into `core` generics |
| Valibot | Schema adapter | Same contract as Zod via Standard Schema | Assume Zod-specific features |
| Effect / Effect Schema | Handler and schema adapter | Run Effect programs as handlers; Effect Schema via its Standard Schema support | Force Effect on users who do not use it |
| oRPC | Transport adapter | Mount an existing oRPC router behind a Holqa HTTP resource; share contracts | Replace oRPC with a proprietary protocol |
| Hono | HTTP adapter | Mount a Hono app through its Fetch handler (`app.fetch`) | Require Hono for HTTP |
| TanStack Query | Frontend client adapter | Typed `queryOptions`/`mutationOptions` and stable query keys from generated clients | Import server modules into the browser |
| TanStack Router | Frontend routing | Keeps owning routing; Holqa supplies typed data clients | Take over routing |
| TanStack Start | Full-stack hosting | Future integration only | Be an initial requirement |
| Vite | Dev server and static builds | Reuse Vite HMR; single-origin dev via proxy where possible; static builds as `staticSite` resources | Build a competing frontend dev server |
| Drizzle, Prisma, native PostgreSQL clients | Data access | Bring your own client; Holqa provides connection configuration through `secret`/`variable` (illustrative) | Introduce a Holqa SQL/ORM abstraction or promise automatic reactivity |
| OpenTelemetry | Observability | Emit traces/logs from the runtime | Require a specific vendor backend |

## Instructions

### Designing an integration

1. Read [docs/integrations/index.md](../../../docs/integrations/index.md), [docs/concepts/type-safety-and-schemas.md](../../../docs/concepts/type-safety-and-schemas.md), and ADR 0006.
2. Write the design as a Proposed section in `docs/integrations/` or a Proposed ADR: the user-facing API (labeled illustrative), the Holqa contract it maps to, unsupported features, and the package's dependencies.
3. Confirm the Holqa contract it depends on exists. Most integrations need `@holqa/sdk` or `@holqa/client`, which are Planned; do not create fake versions of those to unblock an integration.

### Scaffolding a package (only when its dependencies are real)

```text
packages/integrations/<name>/
├── package.json        # "private": true, peerDependencies on the host library
├── tsconfig.json       # extends ../../../tooling/tsconfig.package.json, @/* -> ./src/*
├── tsdown.config.ts    # platform "neutral" for browser-facing code
├── src/index.ts
└── tests/index.test.ts # tests against the real library, not mocks of it
```

- The workspace already includes `packages/integrations/*`. Boundary rules apply automatically.
- Add the host library to the `catalog:` and reference it with `catalog:` in `devDependencies`; declare a `peerDependencies` range that matches what you tested.
- Decide the npm name in the design step; do not publish or reserve names.
- Add the package to `examples/package-smoke` once it has a public entry point.

## Example

Illustrative only; the API is proposed, not implemented, and may change:

```ts
// A Hono app mounted as the handler of a Holqa HTTP resource.
import { Hono } from "hono";
import { resources } from "./infra";

const app = new Hono().get("/health", c => c.text("ok"));

export default resources.api.handle(app.fetch);
```

The adapter's only job is to pass Fetch `Request`/`Response` objects through; Hono keeps routing and middleware.

## Verification checklist

- [ ] The integration depends only on core, sdk, or client; no reverse imports (`pnpm boundaries:check`).
- [ ] The host library is a peer dependency; nothing is vendored or patched.
- [ ] Browser-facing modules import no server, secret, `bun`, or `node:*` code.
- [ ] Unsupported features produce diagnostics or documented limitations.
- [ ] Docs label the integration Planned/Proposed accurately; illustrative code is marked.
- [ ] Tests run against the real library; `pnpm check` passes with real output reported.

## References

- Standard Schema: https://standardschema.dev; Zod: https://zod.dev; Valibot: https://valibot.dev; Effect: https://effect.website
- oRPC: https://orpc.unnoq.com; Hono: https://hono.dev
- TanStack Query: https://tanstack.com/query/latest; TanStack Router: https://tanstack.com/router/latest; TanStack Start: https://tanstack.com/start/latest
- Vite: https://vite.dev; Drizzle: https://orm.drizzle.team; Prisma: https://www.prisma.io/docs; OpenTelemetry JS: https://opentelemetry.io/docs/languages/js/
- Local: [docs/integrations/index.md](../../../docs/integrations/index.md), [docs/architecture/package-boundaries.md](../../../docs/architecture/package-boundaries.md), [ADR 0006](../../../docs/architecture/decisions/0006-standard-schema-and-portable-schema-representation.md)
- Related skills: `holqa-architecture`, `resource-contracts`, `typescript-library`
