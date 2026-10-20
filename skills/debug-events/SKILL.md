---
name: debug-events
description: Diagnoses failing, retried, duplicated or dead-lettered Holqa events — queue messages, storage events, schedules and HTTP/RPC requests — using structured diagnostics with stable HOLQA_* codes, JSON output and event inspection. Use when a handler errors, messages pile up in a dead-letter queue, a schedule did not run, or the CLI or compiler reports a diagnostic.
license: Apache-2.0
metadata:
  status: preview
---

# Debugging events

> **Preview — not yet published.** In the Holqa repository (unpublished): structured diagnostics from the CLI, `holqa inspect --json`, `holqa dev` with structured logs carrying trace identifiers, `holqa invoke`, `queue send`, `storage put`, `cron run`, `holqa state --json`, and the inspection API of `@holqa/local` (messages, dead letters, redrive, storage events, schedule runs) are **implemented**. A CLI command for redriving dead letters and a graphical dashboard are **planned**.

## When to use

- A handler fails or retries repeatedly.
- Messages are in a dead-letter queue.
- A schedule or storage handler did not run, or ran twice.
- Any `HOLQA_*` diagnostic appears.

## Works today

Holqa reports problems as diagnostics with a stable `code`, a `severity`, a `message`, an optional `location` and an optional `hint`. Codes are never renamed or reused, so match on `code`, not on the message.

```sh
holqa queue send orders --data '{"orderId":1}' --app app/infra.ts --json; echo "exit=$?"
# exit=1; standard error holds {"diagnostics":[{"code":"HOLQA_INPUT_INVALID",...}]}
holqa state --app app/infra.ts --json   # queue messages with state, attempts and lastError
```

Every runtime log entry of an invocation carries `handlerId`, `invocationId`, `correlationId` (shared by the whole causal chain: an HTTP request, the messages it sent and the handlers they triggered), `triggerKind`, `resourceId`, and for deliveries `deliveryId` and `attempt`. A handler triggered by a message or object that another invocation sent or wrote has `causationId` set to that invocation. `invocation completed` and `invocation failed` entries list `emitted` messages and objects; failures add `code`, `error` (name, message, stack) and `source` (`module#export`). `holqa dev` prints the first stack frame inside the application.

| Code | Meaning today |
| --- | --- |
| `HOLQA_CLI_NOT_IMPLEMENTED` | The command is proposed but not built (exit 1), for example `holqa openapi generate`. Do not retry; it will not succeed. |
| `HOLQA_RELOAD_FAILED` | A `holqa dev` reload failed; the causes follow it, and the previous generation keeps serving. |
| `HOLQA_HANDLER_FAILED` | A handler threw; the log entry has the original error and source. |
| `HOLQA_CLI_UNKNOWN_COMMAND` | The command is not recognized (exit 2). Run `--help`. |
| `HOLQA_RESOURCE_ID_INVALID` | A resource ID does not match `^[a-z][a-z0-9]*(?:[-.][a-z0-9]+)*$` or exceeds 63 characters. |
| `HOLQA_MANIFEST_NOT_SERIALIZABLE` | A value cannot be written to deterministic JSON; the diagnostic includes a JSON path such as `$.resources[0].id`. |

Human-readable form (without `--json`): `file:line:col severity CODE: message`, followed by an indented `hint:` line. The location prefix is omitted when there is no location.

With the local binding (`@holqa/local`), inspect delivery state directly: `env.queues.deadLetters(queueId)` lists dead-lettered messages with their payload, `schemaVersion`, attempts and last error (`code`, `message`, `invocationId`, which matches the runtime's `invocation failed` log entry); `env.queues.redrive(queueId, messageId)` makes one due again; `env.storage.events(bucketId)` shows each event's delivery state per handler; `env.scheduler.runs(scheduleId)` lists runs as `succeeded`, `failed`, `skipped` or `missed`. See the [local environment reference](../../docs/reference/local.md).

## Workflow

1. **Reproduce locally** with `holqa dev` and the matching trigger (`holqa queue send`, `storage put`, `cron run`, `invoke`).
2. **Inspect the event** with `holqa state --json`: payload, `schemaVersion`, attempts, timestamps and the last error; follow its `correlationId` through the logs to see what triggered the handler and what it emitted.
3. **Classify the failure:**
   - *Validation error* — producer sent an incompatible shape → see `schema-evolution`.
   - *Transient error* (timeouts, rate limits) — retries should resolve it; check backoff and concurrency.
   - *Logic error* — fix the handler, add a test reproducing the payload.
   - *Duplicate side effects* — handler is not idempotent → see `add-queue-consumer`.
   - *Missing capability* — binding cannot satisfy a requirement → see `validate-infrastructure-bindings`.
   - *Event limit* (`HOLQA_EVENT_DEPTH_EXCEEDED`, `HOLQA_EVENT_PUBLICATION_LIMIT_EXCEEDED`, `HOLQA_EXECUTION_BUDGET_EXCEEDED`, `HOLQA_EVENT_AGE_EXCEEDED`) — the delivery was ended without retries, usually by an event cycle or a fan-out. Run `holqa inspect --cycles` to see which handlers trigger each other, and read the dead letter's `trace` (`rootId`, `depth`) for the chain.
4. **Fix and test** with the failing payload as a fixture (`testing-event-driven-apps`).
5. **Replay dead-lettered messages** only after the fix is deployed and only if the handler is idempotent. Locally, `holqa queue redrive <queue> --dry-run` lists what would be replayed, `holqa queue redrive <queue>` (or `env.queues.redrive(queueId)`, `createTestApp(...).redrive(queueId)`) replays it, and `--new-operation` gives messages refused by an event limit a fresh lineage; replay elsewhere is a deliberate, reviewed action.

## Pitfalls

- Matching on message text instead of `code`.
- Replaying a dead-letter queue into a handler that is not idempotent.
- Deleting dead-lettered messages before understanding them.
- Logging full payloads that contain personal data or secrets while debugging.
- Assuming a schedule "ran once" — with overlap policies and retries it may run zero or several times.

## Verification checklist

- [ ] The root cause is identified with a reproduction, not inferred from logs alone.
- [ ] A regression test uses the failing payload.
- [ ] Any replay was approved and the handler is idempotent.
- [ ] No secrets or personal data were added to logs or diagnostics.
- [ ] Diagnostics quoted in reports are copied from real output.
