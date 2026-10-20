# 0033. Deployment artifacts, binding manifests and the container runtime

- **Status:** Proposed
- **Date:** 2026-10-20
- **Deciders:** Holqa maintainers
- **Refines:** [ADR 0022](0022-manifest-v1-and-entry-point-map.md), [ADR 0030](0030-binding-composition-and-resolution.md).

> **Implementation status:** Implemented in `@holqa/bindings` (`createBindingManifest`), `@holqa/container` (`container.host`, `startContainer`, `runContainer`, `verifyArtifact`), `@holqa/runtime-bun` (`serve` probe endpoints) and `@holqa/cli` (`holqa package`). Provisioning, other execution hosts and other runtimes are not part of this decision.

## Context

The application manifest describes what an application needs without naming infrastructure. Running it somewhere also needs the environment's half: which provider binds each resource, with which non-secret settings and credential names, and what must run besides the application. Deployments must be able to check, before serving, that the code, the manifests and the binding that runs all belong together, and the reference way to run an application must not depend on a particular cloud.

## Decision

1. **Two manifests, kept separate.** The application manifest (`manifest.json`, unchanged) stays infrastructure-neutral. The binding manifest (`bindings.json`, format `holqa.binding-manifest/1`) is built from a validated binding report by `createBindingManifest`. It records the configuration's name, the application manifest's fingerprint, the provider protocol and contract versions, every resource-to-provider mapping with its selection reason and requirement support, services, extensions, each provider's contracts, capabilities, non-secret settings, topology and credential **names**, and the connectors the providers need. It holds no credential values, timestamps or paths. An invalid configuration has no binding manifest.
2. **A deployment artifact is a directory.** `holqa package` writes `server.js` (the application, its handlers, the binding configuration and the container runtime, bundled by `bun build --target=bun`), both manifests, the static sites' files, a reference `Dockerfile`, and `artifact.json` (format `holqa.artifact/1`) with the application, the manifest fingerprint, the binding name, the entry point, the minimum Bun version and the SHA-256 and size of every file. The same inputs produce the same files and hashes. Packaging provisions nothing: the artifact binds to infrastructure that exists.
3. **The container runtime checks before it serves.** `startContainer` reads its settings from the environment (`PORT`, `HOST`, shutdown periods), verifies every file of the artifact against `artifact.json` and the Bun version, resolves the binding configuration and refuses it unless the resulting binding manifest equals the packaged `bindings.json`. A provider setting that differs from packaging time is a mismatch (`HOLQA_ARTIFACT_INVALID`), never silently used; values that differ per deployment belong in credential references. It then composes the binding, validates every handler's delivery and the host's limits, starts the shared runtime and serves HTTP.
4. **Conventional deployment primitives.** Liveness (`/.holqa/live`) and readiness (`/.holqa/ready`) probes are answered before routing; readiness follows `runtime.health().ready`. `SIGTERM` and `SIGINT` drain in-flight work within the grace period, stop providers in reverse order and exit with status `0`. Start failures are written as one JSON line of diagnostics to standard error with exit status `1`. The reference Dockerfile uses the official Bun image, an unprivileged user and the readiness probe; nothing names a hosting product.
5. **The container is an execution host provider.** `container.host()` binds `http.api` and `static.site` and declares the `execution` contract (`bun`, `long-running`, optional concurrency and timeout limits), so background delivery from pull-based providers is valid and limits are checked by `validateBindings`. Queues, buckets, schedules, configuration and telemetry come from other providers.

## Consequences

### Positive

- The artifact can be audited without running it: what runs, against which infrastructure, needing which credentials and connectors.
- Configuration drift between packaging and start is a start-up error, not a runtime surprise.
- Any container platform, process manager or plain `bun server.js` can run the artifact.

### Negative

- Each environment needs its own package, because non-secret settings are part of the binding manifest.
- The bundle contains the binding configuration of one environment.
- Hashes protect against accidental change, not against an attacker who can rewrite `artifact.json`; signing is not part of this decision.

### Revisit when

- Artifacts need signatures, or one artifact must serve several environments.
- Other runtimes or execution hosts (request-driven platforms, workers) are added.

## Alternatives considered

### Embedding the binding manifest in the application manifest

Rejected: the application manifest must stay infrastructure-neutral and identical across environments.

### Resolving bindings only at start, without a packaged binding manifest

Rejected: nothing would show before deployment which infrastructure the artifact binds, and drift would go unnoticed.

### Bundling in the CLI process

Rejected: repeated in-process `Bun.build` calls were unreliable on Bun 1.3.13, and a separate `bun build` process keeps bundling isolated from the CLI.

## Related

- [Container runtime reference](../../reference/container.md)
- [CLI reference: `holqa package`](../../reference/cli.md#holqa-package)
- [Binding contracts reference](../../reference/bindings.md#binding-manifests)
