---
name: security-review
description: Reviews a Holqa application for security problems — secrets reaching clients, logs or messages; missing runtime validation at trust boundaries; broken authorization in HTTP routes and RPC procedures; unsafe storage access and signed URLs; non-idempotent handlers; and destructive infrastructure changes. Use before merging changes to infra.ts, handlers, generated clients or bindings, and before any deployment.
license: Apache-2.0
metadata:
  status: preview
---

# Security review

> **Preview — the APIs referenced are not yet available.** The SDK, generated clients and bindings named here are **proposed**. The review checklist applies to any code written against the proposed API, and most items apply to event-driven backends in general.

## When to use

- Reviewing a pull request that touches `infra.ts`, handlers, the frontend client or infrastructure bindings.
- Before deploying to a new environment.
- After an incident involving leaked data or duplicated side effects.

## Works today

Nothing Holqa-specific runs. Perform the review by reading code. Useful plain checks:

```sh
# Frontend code must not import server modules
grep -rnE "from ['\"](\.\./)+(infra|src/)" web/src
# Look for secrets committed by mistake
git grep -nE "(api[_-]?key|secret|password|token)\s*[:=]\s*['\"][^'\"]{8,}"
```

## Review workflow

1. **Map trust boundaries.** List every entry point: HTTP routes, RPC procedures, queue consumers, storage events, schedules, webhooks. Each must validate its input with a runtime schema.
2. **Check secrets.**
   - Declared with `secret(...)` in `infra.ts`; values never appear in source.
   - Read only in server-side handlers via `config`.
   - Never placed in responses, queue messages, object metadata, logs or diagnostics.
3. **Check browser safety.** Code under `web/` imports only the generated client. The client must not include handlers, internal procedures or `config`. Inspect the built bundle if available.
4. **Check authentication and authorization.** Middleware authenticates; each handler authorizes access to the specific record (ownership, tenant). UI checks do not count.
5. **Check outputs.** Responses use explicit output schemas; no raw rows, stack traces or internal IDs that should stay private.
6. **Check storage.** Buckets are `access: "private"` unless intentionally public. Signed URLs are short-lived, single-key and issued to authenticated callers for server-chosen keys. Uploaded metadata is validated.
7. **Check event handlers.** Delivery is at-least-once; side effects (payments, emails) must be idempotent. Webhooks verify signatures on the raw body.
8. **Check infrastructure changes.** Changed resource `id`s, removed declarations and binding changes are listed explicitly. Nothing deletes infrastructure implicitly. Runtime credentials do not include provisioning rights.
9. **Check the dependency surface** of the generated client and frontend for server-only packages.

Illustrative example of a finding:

```ts
// Finding: secret leaked to the client contract (proposed API)
export default resources.api.query({
  id: "settings.get",
  output: z.object({ apiKey: z.string() }),          // exposes a secret in the public contract
  handler: async () => ({ apiKey: config.PAYMENT_API_KEY })
});
// Fix: never return the key; perform the payment call server-side.
```

## Pitfalls

- Treating TypeScript types as validation.
- Relying on obscurity of RPC procedure IDs; every procedure is callable by anyone who can reach the API.
- Logging full request bodies or messages while debugging.
- Allowing an agent or script to apply infrastructure plans that delete resources without review.

## Verification checklist

- [ ] Every entry point validates input with a runtime schema.
- [ ] No secret value is in source, client bundles, responses, messages, logs or diagnostics.
- [ ] Frontend code imports only the generated client.
- [ ] Every handler that reads or mutates user data checks authorization.
- [ ] Storage access is private by default; signed URLs are short-lived and scoped.
- [ ] Event handlers with external side effects are idempotent.
- [ ] No implicit infrastructure deletion; resource `id` changes are flagged.
- [ ] Findings cite file and line and are verified, not assumed.
