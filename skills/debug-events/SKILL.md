---
name: debug-events
description: Diagnoses failing, retried, duplicated or dead-lettered Holqa events — queue messages, storage events, schedules and HTTP/RPC requests — using structured diagnostics with stable HOLQA_* codes, JSON output and event inspection. Use when a handler errors, messages pile up in a dead-letter queue, a schedule did not run, or the CLI or compiler reports a diagnostic.
license: Apache-2.0
metadata:
  status: preview
---

# Debugging events

> **Preview — mostly not available.** Event inspection, replay and `holqa invoke` are **proposed**. What works today is reading structured diagnostics from the CLI, and `holqa inspect --json` (in the Holqa repository) to see which handlers are bound to which resources.

## When to use

- A handler fails or retries repeatedly.
- Messages are in a dead-letter queue.
- A schedule or storage handler did not run, or ran twice.
- Any `HOLQA_*` diagnostic appears.

## Works today

Holqa reports problems as diagnostics with a stable `code`, a `severity`, a `message`, an optional `location` and an optional `hint`. Codes are never renamed or reused, so match on `code`, not on the message.

```sh
bun packages/cli/dist/bin.js queue send --json; echo "exit=$?"
# stderr: {"diagnostics":[{"code":"HOLQA_CLI_NOT_IMPLEMENTED","severity":"error",
#          "message":"\"holqa queue send\" is a proposed command and is not implemented yet.",
#          "hint":"See docs/roadmap.md for implementation status."}]}
# exit=1
```

| Code | Meaning today |
| --- | --- |
| `HOLQA_CLI_NOT_IMPLEMENTED` | The command is proposed but not built (exit 1). Do not retry; it will not succeed. |
| `HOLQA_CLI_UNKNOWN_COMMAND` | The command is not recognized (exit 2). Run `--help`. |
| `HOLQA_RESOURCE_ID_INVALID` | A resource ID does not match `^[a-z][a-z0-9]*(?:[-.][a-z0-9]+)*$` or exceeds 63 characters. |
| `HOLQA_MANIFEST_NOT_SERIALIZABLE` | A value cannot be written to deterministic JSON; the diagnostic includes a JSON path such as `$.resources[0].id`. |

Human-readable form (without `--json`): `file:line:col severity CODE: message`, followed by an indented `hint:` line. The location prefix is omitted when there is no location.

## Planned workflow

1. **Reproduce locally** with `holqa dev` and the matching trigger (`queue send`, `storage put`, `cron run`, `invoke`).
2. **Inspect the event**: payload, `schemaVersion`, attempt number, timestamps and the handler `id` that received it.
3. **Classify the failure:**
   - *Validation error* — producer sent an incompatible shape → see `schema-evolution`.
   - *Transient error* (timeouts, rate limits) — retries should resolve it; check backoff and concurrency.
   - *Logic error* — fix the handler, add a test reproducing the payload.
   - *Duplicate side effects* — handler is not idempotent → see `add-queue-consumer`.
   - *Missing capability* — binding cannot satisfy a requirement → see `validate-infrastructure-bindings`.
4. **Fix and test** with the failing payload as a fixture (`testing-event-driven-apps`).
5. **Replay dead-lettered messages** only after the fix is deployed and only if the handler is idempotent. Replay is a deliberate, reviewed action.

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
