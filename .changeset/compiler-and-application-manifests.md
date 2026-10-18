---
"@holqa/core": minor
"@holqa/compiler": minor
"@holqa/cli": minor
"@holqa/sdk": minor
---

Add the compiler pipeline, application manifests and the `holqa inspect` / `holqa build --manifest` commands.

- `@holqa/core`: fourteen new diagnostic codes for the compiler and CLI (`HOLQA_APP_NOT_FOUND`, `HOLQA_APP_INVALID`, `HOLQA_MODULE_EVALUATION_FAILED`, `HOLQA_HANDLER_PATTERN_UNMATCHED`, `HOLQA_HANDLER_ID_DUPLICATE`, `HOLQA_RESOURCE_NOT_FOUND`, `HOLQA_TRIGGER_INVALID`, `HOLQA_QUEUE_CONSUMER_DUPLICATE`, `HOLQA_ROUTE_CONFLICT`, `HOLQA_MANIFEST_INVALID`, `HOLQA_MANIFEST_VERSION_UNSUPPORTED`, `HOLQA_ANALYSIS_FAILED`, `HOLQA_CLI_ARGUMENT_INVALID`, `HOLQA_BUILD_OUTPUT_FAILED`). Additive.
- `@holqa/compiler`: `compileApplication` (handler discovery, graph validation, manifest version 1 and the `holqa.entrypoints/1` map), `selectHandlerModules`, `compileGlob`, `discoverHandlers`, `serializeManifest`, `serializeEntrypoints`, `fingerprintManifest`, `validateManifest`, `validateEntrypoints`, `buildResourceGraph`, `moduleEvaluationFailure`, `sortDiagnostics`, `hasErrors`, and the manifest and entry point JSON Schemas (also published as `@holqa/compiler/manifest-v1.schema.json` and `@holqa/compiler/entrypoints-v1.schema.json`). Additive.
- `@holqa/cli`: `holqa inspect` and `holqa build --manifest`, evaluating applications in a separate Bun process with an allowlisted environment (`createProcessHost`). **Breaking:** `runCli` now returns `Promise<number>` and takes an optional `host`; migrate with `await runCli(...)`. `proposedCommands` no longer lists `inspect` and `build`, which moved to the new `implementedCommands`; `holqa build` without `--manifest` still reports `HOLQA_CLI_NOT_IMPLEMENTED`. Unknown or malformed options after `inspect` or `build` (previously reported as `HOLQA_CLI_NOT_IMPLEMENTED` with exit code 1) now exit with code 2 and `HOLQA_CLI_ARGUMENT_INVALID`. The CLI now depends on `@holqa/compiler`.
- `@holqa/sdk`: the object-created event schema of `bucket(...).onObjectCreated` implements Standard JSON Schema, so the compiler can record the event contract. Additive.
