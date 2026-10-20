# 0031. Static sites as a resource kind served through bindings

- **Status:** Proposed
- **Date:** 2026-10-20
- **Deciders:** Holqa maintainers
- **Refines:** [ADR 0018](0018-typed-kind-registries-in-the-descriptor-protocol.md), [ADR 0029](0029-binding-provider-protocol-and-versioned-contracts.md).

> **Implementation status:** Implemented in `@holqa/core` (the `static.site` kind and binding contract), `@holqa/sdk` (`staticSite`), `@holqa/compiler` (normalization and manifest version 1), `@holqa/runtime-bun` (serving unmatched `GET` and `HEAD` requests) and `@holqa/local` (files from the application root).

## Context

A static frontend was a proposed factory (`staticSite({ id, root, build, spaFallback })`) with no implementation. Hosting it is one of the mandatory areas of a complete platform: a managed host serves it from storage or a CDN, a container serves it from files next to the application, the local platform from the developer's build output. The declaration must stay infrastructure-neutral, and the frontend build (Vite or another tool) must stay that tool's job.

## Decision

1. **`static.site` is a resource kind** in the kind registry: config `{ directory, basePath }` (the artifacts' directory relative to the application root, and the URL prefix), requirement `{ spaFallback }`, capability `{ spaFallback }`, and a driver with one operation, `fetch(path, request)`, that answers `GET` and `HEAD` requests with a file or `undefined`. The required capabilities are `static.site` and `static.site.spa-fallback`.
2. **The declaration names artifacts, not a build.** `staticSite({ id, directory, basePath?, spa? })` records where built files are. Holqa never runs a build command: declarations are side-effect free, and running arbitrary commands is not a binding's job. The directory must be relative, inside the application, with `/` separators and no `.`, `..` or empty segments, checked when declared and when compiled.
3. **Routes win.** The runtime serves a static site only for `GET` and `HEAD` requests that match no route or procedure, choosing the site with the longest matching base path. Two sites with one base path are a `HOLQA_ROUTE_CONFLICT`. API and site separation therefore never depends on registration order.
4. **`static.site` is a mandatory contract** of a complete platform (`mandatoryBindingContracts`). A binding that cannot host a declared site fails at start with `HOLQA_BINDING_CAPABILITY_UNSUPPORTED`; the runtime's default environment binding hosts none.
5. **Local hosting serves files from the application root**, refusing any path that leaves the site's directory, answering directories with their `index.html`, extension-less unknown paths with the root `index.html` when `spaFallback` is required, and HTML with `cache-control: no-cache`. HTTPS, CDN caching, preview deployments and image optimization are properties of a deployment's host, not of the contract.
6. **Manifest version 1 is extended additively** with the `static.site` resource; manifests of applications without sites are unchanged byte for byte.

## Consequences

### Positive

- One application declares its API and its frontend; every binding serves both or says it cannot.
- Frontend tooling keeps owning builds and hot module replacement.

### Negative

- Readers of manifest version 1 built before this change reject manifests with static sites.
- Content negotiation, compression and range requests are not part of the contract.

### Revisit when

- A provider serves sites from object storage or a CDN and needs per-site settings (cache policy, headers) that should be declared rather than configured in the binding.

## Alternatives considered

### Declaring the build command

Rejected: the compiler and runtime would execute arbitrary commands, and the frontend tool already owns its build.

### Serving sites before routes

Rejected: a file named like an API path would shadow the API.

## Related

- [Binding contracts reference](../../reference/bindings.md#staticsite)
- [Runtime reference](../../reference/runtime.md#static-sites)
