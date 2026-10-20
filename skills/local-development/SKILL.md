---
name: local-development
description: Runs a Holqa application locally without cloud credentials with holqa dev — Bun-based handler execution, HTTP and RPC routing, emulated queues, storage and schedules, hot handler replacement and reloads on file changes, a local development dashboard — and triggers events manually with holqa invoke, queue send, storage put and cron run. Use when starting the dev server, reproducing a bug locally, or inspecting local queue, storage and schedule state.
license: Apache-2.0
metadata:
  status: preview
---

# Running local development

> **Preview — not yet published.** `holqa dev`, `invoke`, `queue send`, `storage put`, `cron run`, `state` and `doctor` are **implemented** in the Holqa repository (`@holqa/cli`, unpublished); their options may change. `holqa dev` replaces changed handlers in the running process when it is safe, restarts the application process otherwise, and serves a read-only dashboard at `/_holqa/dashboard`. Module unloading, type checking during reload and the Vite integration are **planned**: old module copies stay in memory until a restart, and the frontend is not served yet.

## When to use

- Running the backend locally with emulated queues, object storage and schedules.
- Triggering a queue message, storage event, schedule or handler by hand.
- Inspecting what the local runtime received and how handlers responded.

## Workflow

From an application directory in the Holqa repository (for example [`examples/order-pipeline`](../../examples/order-pipeline/README.md)), after `pnpm install && pnpm build`:

1. **Check the project:** `holqa doctor --app app/infra.ts` verifies Bun, the application, its configuration and capabilities, the local state and the dev port. Exit `1` means a check failed.
2. **Start everything:** `holqa dev --app app/infra.ts` (default port 3000; `--port 0` picks a free one). It analyzes the application, starts it with the local drivers, prints resources, handlers, endpoints and the next schedule runs, and streams structured logs. State is kept in `.holqa/local` next to `infra.ts` and survives restarts.
3. **Configure local values** for `secret` and `variable` entries in a `.env` file next to `infra.ts`, never committed. Changing it restarts the application.
4. **Trigger events manually** (in another terminal; they run inside the dev session when it is running):

   ```sh
   holqa invoke orders.process --input '{"orderId":"123"}' --app app/infra.ts
   holqa queue send orders --data '{"orderId":"123"}' --app app/infra.ts
   holqa storage put uploads ./sample.pdf --app app/infra.ts
   holqa cron run cleanup --app app/infra.ts
   ```

5. **Inspect local state:** `holqa state --app app/infra.ts` lists queue messages (state, attempts, last error), objects, object events with each handler's delivery, and schedule runs. The same session's handlers and versions, queue backlog, dead letters, schedules, reloads, build diagnostics, recent logs and traces are on the read-only dashboard at `http://localhost:3000/_holqa/dashboard` (loopback addresses only; `--no-dashboard` turns it off; message payloads are never shown).
6. **Edit code.** A change that only touches handler modules (or modules only they import) is applied in the running process: in-flight invocations finish on the old code, new ones run the new code, and local state and queue consumers are kept. Other changes (the application module, resources, configuration, handler definitions, `.env`, dependencies) restart the application; local state survives. A schema change also reports contract diagnostics such as `HOLQA_SCHEMA_CHANGE_BREAKING`, and waiting messages that no longer match a queue's contract are reported as `HOLQA_QUEUED_MESSAGE_INCOMPATIBLE`. A change that breaks the application reports `HOLQA_RELOAD_FAILED` (or a failed swap); the previous version keeps serving and the session is marked stale. Use `--no-hot` to restart on every change.
7. Use `--json` everywhere when another tool or agent consumes the output: one JSON document per command, and one JSON event per line for `holqa dev --json`.

## Pitfalls

- **Trusting local guarantees.** Local delivery is at least once and unordered, like production. Code that passes only because a message happened to arrive once is still wrong; use `createTestApp(...).duplicate` to check.
- **Real credentials locally.** Local development needs no cloud credentials. Do not point local runs at production resources.
- **Committing local secrets.** Keep `.env` files out of version control.
- **Parsing human output.** Messages may change; diagnostic codes, exit codes and `--json` output are the stable contract.
- **Module state across invocations.** `holqa invoke` without a running dev session runs in a new process, so in-memory state of the dev session is not visible to it, and a hot replacement gives replaced handler modules fresh module state. Keep state in resources.
- **Side effects at module load.** A handler module that starts timers, listeners or servers when it loads is never hot-replaced; the application restarts instead. Add a `holqa:restart-on-change` comment to a module that must always restart.
- **Expecting type errors on reload.** `holqa dev` does not type-check; run `pnpm typecheck` separately.
- **Testing only the happy path.** Send malformed messages and duplicates too.

## Verification checklist

- [ ] You stated clearly whether a command was actually run.
- [ ] Local configuration contains no production credentials and is ignored by version control.
- [ ] Each handler was exercised at least once through its trigger (HTTP, queue, storage, schedule).
- [ ] Duplicate and failing deliveries were tried, not only successful ones.
- [ ] Automation reads `--json` output and exit codes rather than formatted text.
