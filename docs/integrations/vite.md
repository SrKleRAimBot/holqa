# Vite

> **Status:** Planned. No Vite integration exists. See [local development](../concepts/local-development.md) and Phase 4 of the [roadmap](../roadmap.md).

Vite is the planned integration for frontend development and static builds. Holqa reuses Vite's dev server and HMR rather than building another frontend development server.

## Goals

| Goal | Description |
| --- | --- |
| Frontend HMR | Vite keeps full ownership of frontend module graphs and hot module replacement. |
| Single-origin development | API and RPC requests from the frontend reach the Holqa backend on the same origin, so cookies, CORS, and relative URLs behave as in production. |
| Static builds | A `staticSite` resource (**Implemented**) serves Vite's build output: `staticSite({ id: "web", directory: "web/dist", spa: true })`. Running `vite build` stays Vite's job. |
| Generated clients | Generated browser-safe clients are regenerated when public contracts change, and Vite picks them up through normal HMR. |

## Intended shape

Two complementary integration points are under consideration (**Proposed**):

1. **Vite plugin.** A plugin that forwards requests for declared API base paths (for example `/api`) to the Holqa runtime started by `holqa dev`, using Vite's server middleware.
2. **`holqa dev` hosting Vite.** `holqa dev` starts Vite in middleware mode for the frontend and routes everything else to Holqa.

Either way, Vite remains responsible for the frontend and Holqa for the backend; neither reimplements the other.

The following code is illustrative. The API is proposed, not implemented, and may change.

```ts
// web/vite.config.ts (illustrative)
import { defineConfig } from "vite";
import { holqa } from "@holqa/vite"; // package name not decided

export default defineConfig({
  plugins: [holqa({ app: "../infra.ts" })]
});
```

```ts
// infra.ts: staticSite is implemented; the Vite integration above is not.
web: staticSite({ id: "web", directory: "web/dist", spa: true })
```

## Considerations

- **Backend reloads are separate from frontend HMR.** A change to a handler triggers a backend reload in the Holqa runtime, not a Vite HMR update. A change to a public contract may trigger both (backend reload and client regeneration).
- **No server code in the browser bundle.** The frontend imports generated clients only. Importing `infra.ts` from frontend code should be detected and rejected.
- **SPA fallback.** `spaFallback: true` serves the index document for unknown paths, outside declared API base paths.

## Related

- [Local development](../concepts/local-development.md)
- [TanStack](tanstack.md)
- [Integrations](index.md)
