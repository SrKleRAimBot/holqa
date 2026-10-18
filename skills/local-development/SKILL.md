---
name: local-development
description: Runs a Holqa application locally without cloud credentials — Bun-based handler execution, HTTP and RPC routing, emulated queues, storage and schedules, event inspection, and Vite HMR on a single origin — and triggers events manually. Use when starting the dev server, reproducing a bug locally, or wiring a Vite frontend to the backend.
license: Apache-2.0
metadata:
  status: preview
---

# Running local development

> **Preview — not yet available.** `holqa dev`, `invoke`, `queue send`, `storage put` and `cron run` are **proposed** commands. Today each one exits with code 1 and reports `HOLQA_CLI_NOT_IMPLEMENTED`. `holqa inspect` and `holqa build --manifest` are implemented. In the Holqa repository (unpublished), `@holqa/runtime-bun` runs a compiled application and `@holqa/local` provides local queues, object storage and a scheduler, so the whole application runs locally from a script.

## When to use

- Starting the backend and frontend together for development.
- Triggering a queue message, storage event or schedule by hand.
- Inspecting what the local runtime received and how handlers responded.

## Works today

From a checkout of the Holqa repository after `pnpm install && pnpm build`:

```sh
bun packages/cli/dist/bin.js --help          # shows the proposed commands below
bun packages/cli/dist/bin.js dev --json      # exit 1
# stderr: {"diagnostics":[{"code":"HOLQA_CLI_NOT_IMPLEMENTED","severity":"error",...}]}
bun packages/cli/dist/bin.js deploy          # exit 2, HOLQA_CLI_UNKNOWN_COMMAND
```

Use the exit code and the `code` field, not the message text, when scripting against the CLI.

The local drivers work today from a script (see [`examples/document-processing`](../../examples/document-processing/README.md) and the [local environment reference](../../docs/reference/local.md)):

```ts
import { createLocalEnvironment } from "@holqa/local";
import { createRuntime, loadCompiledApplication } from "@holqa/runtime-bun";

const compiled = await loadCompiledApplication({ root: import.meta.dir });
const local = await createLocalEnvironment({ app: compiled.app, directory: ".holqa/local" });
const runtime = createRuntime({ ...compiled, binding: local.binding });
await runtime.start();
// Inspect: local.queues.messages("order-processing"), local.queues.deadLetters(...),
// local.storage.events("uploads"), local.scheduler.runs("nightly"); trigger: local.scheduler.trigger("nightly").
```

## Planned workflow

1. **Start everything:** `holqa dev`. It is planned to discover `infra.ts`, start Bun-based handler execution, emulate queues, storage (filesystem-backed) and schedules, and mount the Vite dev server so the frontend and API share one origin.
2. **Configure local values** for `secret` and `variable` entries through local environment files that are never committed.
3. **Inspect the graph:** `holqa inspect --json` (implemented) lists resources, handlers, configuration and required capabilities. Routes and procedures appear as `http.route` and `http.procedure` handlers.
4. **Trigger events manually:**

   ```sh
   holqa queue send order-processing '{"orderId":"3f0c…","priority":"urgent"}'
   holqa storage put customer-uploads incoming/test.png ./fixtures/test.png
   holqa cron run daily-cleanup
   holqa invoke orders.process --event ./fixtures/order-event.json
   ```

5. **Watch structured logs and diagnostics**; use `--json` when another tool or agent consumes the output.
6. **Edit code.** Backend modules are planned to reload without full restarts; the frontend uses Vite HMR.

Vite configuration is planned to use a plugin rather than a separate dev server (illustrative):

```ts
// web/vite.config.ts — illustrative; plugin name is a placeholder
import { holqa } from "@holqa/vite";
import { defineConfig } from "vite";

export default defineConfig({ plugins: [holqa({ app: "../infra.ts" })] });
```

## Pitfalls

- **Trusting local guarantees.** The local runtime must not provide stronger delivery or ordering than production. Code that passes only because local delivery happened to be exactly-once and in order is still wrong.
- **Real credentials locally.** Local development is meant to work without cloud credentials. Do not point local runs at production resources.
- **Committing local secrets.** Keep local env files out of version control.
- **Parsing human output.** Messages may change; codes and `--json` output are the stable contract.
- **Testing only the happy path.** Use manual triggers to send duplicates and malformed messages too.

## Verification checklist

- [ ] You stated clearly whether a command was actually run or is proposed.
- [ ] Local configuration contains no production credentials and is ignored by version control.
- [ ] Each handler was exercised at least once through its trigger (HTTP, queue, storage, schedule).
- [ ] Duplicate and failing deliveries were tried, not only successful ones.
- [ ] Automation reads `--json` output and exit codes rather than formatted text.
