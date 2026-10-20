# Container runtime

> **Status:** **Implemented** in `@holqa/container` (private, unpublished) and `holqa package` in `@holqa/cli`. The design is recorded in [ADR 0033](../architecture/decisions/0033-deployment-artifacts-and-binding-manifests.md).

The conventional way to run a Holqa application outside development: `holqa package` writes a deployment artifact for one binding configuration, and the artifact's `server.js` runs it in one long-running Bun process, in a container or under any process manager.

## Binding the container host

`container.host()` is the execution host of a container: a resource provider for `http.api` and `static.site` that declares the `execution` contract (`runtimes: ["bun"]`, `mode: "long-running"`). Select it for those kinds and use other providers for the rest.

```ts
// bindings.production.ts
import { defineBindings, environmentConfig } from "@holqa/bindings";
import { container } from "@holqa/container";
import { credentialRef } from "@holqa/core";
import { rabbitmq } from "@holqa/rabbitmq";
import { s3 } from "@holqa/s3";
import app from "./infra";

const host = container.host();

export default defineBindings(app, {
  name: "production",
  kinds: {
    "http.api": host,
    "static.site": host,
    "queue": rabbitmq.queues({ url: credentialRef("QUEUE_URL"), delayedDelivery: "delay-queues" }),
    "bucket": s3.buckets({ endpoint: "http://object-store:9000", accessKeyId: credentialRef("S3_ACCESS_KEY_ID"), secretAccessKey: credentialRef("S3_SECRET_ACCESS_KEY") })
  },
  services: { config: environmentConfig() }
});
```

| Option | Default | Meaning |
| --- | --- | --- |
| `name` | `container` | The provider's name. |
| `root` | `.` | The directory static sites' directories are relative to, resolved against the working directory when the binding starts. The packaged entry point makes the artifact directory the working directory. |
| `maxConcurrency`, `maxTimeoutMs` | none | Limits the deployment imposes; `validateBindings` checks the runtime's limits against them. |

The host needs no credentials and provisions nothing. Static sites are served from files with path containment and single-page fallback, as in the [local environment](local.md).

## Packaging

```bash
holqa package --bindings bindings.production.ts
```

writes `.holqa/package/<binding name>/` next to the application module (or `--out-dir`). See the [CLI reference](cli.md#holqa-package).

| File | Content |
| --- | --- |
| `server.js` | The application, its handlers, the binding configuration and the container runtime, bundled by `bun build --target=bun`. Starting it runs `runContainer` on its own directory. |
| `manifest.json` | The application manifest, canonical JSON. |
| `bindings.json` | The binding manifest (`holqa.binding-manifest/1`, [format](bindings.md#binding-manifests)), canonical JSON. |
| `<directory>/...` | Each static site's files, at the directory the site declares. |
| `Dockerfile` | A reference image: the official Bun image of the packaging Bun version, `WORKDIR /app`, an unprivileged user, `HEALTHCHECK` on the readiness probe, `STOPSIGNAL SIGTERM`, `CMD ["bun", "server.js"]`. Review it before use. |
| `artifact.json` | The descriptor (`holqa.artifact/1`), canonical JSON: `application`, `manifest` (fingerprint), `bindings` (configuration name), `entry`, `runtime.bun` (minimum version), `staticSites`, and `files` with each file's `path`, `sha256` and `bytes`, sorted by path. |

The same inputs produce the same files and hashes; the bundle holds no absolute paths. Packaging fails with `HOLQA_PACKAGE_FAILED` when a static site's directory does not exist (build the frontend first), bundling fails, or the output directory is not empty and holds no previous artifact (it never replaces a directory it did not write). An invalid binding configuration produces no artifact.

## Start-up

`runContainer` (the packaged entry point) makes the artifact directory the working directory and calls `startContainer`, which, in order:

| Step | Failure |
| --- | --- |
| Reads settings from the environment (below). | `HOLQA_CONTAINER_SETTINGS_INVALID` |
| Verifies the artifact: every listed file exists with its size and SHA-256, the entry point and both manifests are listed, and Bun is at least `runtime.bun`. | `HOLQA_ARTIFACT_INVALID` (`details.file` names the file) |
| Checks that the binding configuration binds the packaged application. | `HOLQA_BINDING_CONFIG_INVALID`, `HOLQA_ARTIFACT_INVALID` |
| Resolves the configuration and builds its binding manifest; it must equal `bindings.json`. | The configuration's diagnostics; `HOLQA_ARTIFACT_INVALID` (`details.fields`) on drift |
| Composes the binding, creates the runtime and validates every handler's delivery and the host's limits. | The validation's diagnostics |
| Starts the runtime (opens and readies every provider, starts background deliveries) and serves HTTP. | `HOLQA_RUNTIME_START_FAILED` and the providers' classified failures |

A failed start writes `{"level":"error","message":"container failed to start","diagnostics":[...]}` as one line to standard error and exits with status `1`. Diagnostics never contain credential values. A successful start logs `container serving` with the URL, binding name and manifest fingerprint as a JSON line; every log line is JSON on standard output.

`startContainer(options)` can also run an application from source (without `directory`, which skips both artifact checks), for example in tests: `{ app, handlers, bindings, directory?, env?, log?, limits?, telemetry?, signals? }`, resolving to `{ url, port, runtime, stop }`.

## Settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3000` | The port; `0` picks a free one. |
| `HOST` | `0.0.0.0` | The interface. |
| `HOLQA_SHUTDOWN_GRACE_MS` | `10000` | How long in-flight work may finish after a termination signal. Keep it below the platform's own grace period. |
| `HOLQA_SHUTDOWN_FORCE_MS` | `1000` | How long to wait after cancelling work that ignores its signal. |
| `HOLQA_MAX_REQUEST_BODY_BYTES` | `1048576` | The largest request body; larger ones get `413`. |

Configuration entries and credentials are read by the selected configuration service, by default the process environment.

## Probes and shutdown

| Path | Answer |
| --- | --- |
| `/.holqa/live` | `200` `{ status: "live", state }` while the process serves requests, including while it drains. |
| `/.holqa/ready` | `200` while the runtime is running and no binding component is unhealthy, `503` otherwise (starting, stopping, a component unhealthy), with `runtime.health()` as JSON. |

Probes are answered before routing and are not cached. On `SIGTERM` or `SIGINT` the runtime stops accepting work (new requests get `503`, readiness turns `503`), in-flight invocations get the grace period, background consumers stop and return unsettled deliveries, providers are stopped in reverse order, and the process exits with status `0`.

## Limits

| Topic | Behaviour |
| --- | --- |
| Runtimes | Bun only. The artifact needs at least the packaging Bun version. |
| Integrity | Hashes detect accidental or partial changes. They are not signatures: anyone who can rewrite `artifact.json` can change the artifact. |
| Environments | One artifact per binding configuration, because non-secret settings are part of `bindings.json`. Use credential references for values that differ between deployments of the same environment. |
| Replicas | Each replica is a full process: it serves HTTP and consumes background deliveries. Shared providers (for example RabbitMQ and S3-compatible stores) distribute work between replicas; process-local state (for example the local platform) does not. |
| Trust | `server.js` runs the application's code with the process's permissions. |
