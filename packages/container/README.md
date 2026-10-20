# @holqa/container

The conventional Bun container runtime for Holqa: `container.host()`, an execution host provider for HTTP APIs and
static sites, and `startContainer`, which verifies a packaged artifact, resolves its bindings, serves HTTP with
liveness and readiness probes, runs background deliveries and drains on termination signals.

> **Status:** Implemented, private and unpublished. The API may change before the first release.

```bash
holqa package --bindings bindings.production.ts
cd .holqa/package/production && bun server.js
```

It provisions nothing and names no hosting product. See the [container runtime reference](../../docs/reference/container.md).
