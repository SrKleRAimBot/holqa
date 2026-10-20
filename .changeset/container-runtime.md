---
"@holqa/bindings": minor
"@holqa/cli": minor
"@holqa/container": minor
"@holqa/core": minor
"@holqa/local": minor
"@holqa/runtime-bun": minor
---

Add deployment artifacts and the conventional Bun container runtime. `holqa package` resolves and validates a binding configuration and writes `server.js` (the bundled application and container runtime), `manifest.json`, `bindings.json` (the new `holqa.binding-manifest/1` binding manifest from `createBindingManifest`), static site files, a reference Dockerfile and `artifact.json` with every file's SHA-256. The new `@holqa/container` package provides `container.host()` (the execution host for HTTP APIs and static sites) and `startContainer`/`runContainer`, which verify the artifact, refuse a binding that differs from the packaged binding manifest, serve liveness and readiness probes, and drain on `SIGTERM`. `serve` in `@holqa/runtime-bun` gains optional probe endpoints, `@holqa/local` exports its static site driver, and `@holqa/core` adds `HOLQA_PACKAGE_FAILED`, `HOLQA_ARTIFACT_INVALID` and `HOLQA_CONTAINER_SETTINGS_INVALID`. `createBinding` now forwards `static.site` drivers, which composed bindings previously dropped.
