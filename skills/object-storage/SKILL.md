---
name: object-storage
description: Works with Holqa bucket resources — reading and writing objects, issuing signed upload and download URLs, choosing access policies, and handling object-created and object-deleted events idempotently. Use when adding file uploads, serving private files, or reacting to new objects.
license: Apache-2.0
metadata:
  status: preview
---

# Working with object storage

> **Preview — not yet published.** `bucket(...)`, object operations (`put`, `get`, `head`, `delete`, `list`), `signedUrl`, and `onObjectCreated` / `onObjectDeleted` are implemented in the Holqa repository (`@holqa/sdk`, unpublished); `@holqa/runtime-bun` delivers storage events from a binding such as `@holqa/local`. `holqa storage put` is a **proposed** command and reports `HOLQA_CLI_NOT_IMPLEMENTED`.

## When to use

- Accepting user uploads or storing generated files.
- Serving private files through short-lived signed URLs.
- Running a handler when an object is created or deleted.

## Works today

In the Holqa repository: bucket declarations, the object operations above with portable key rules (`HOLQA_OBJECT_KEY_INVALID`) and bounded listing (`limit` 1 to 1000, `cursor`), signed `GET`/`PUT` URLs, and object-created and object-deleted handlers. Events use the `holqa.object-event/1` envelope; each handler receives `event.id` (stable across redeliveries) and `event.attempt`. Locally, `@holqa/local` stores objects on the filesystem, serves development signed URLs (`storage.fetch`) and lets you inspect and duplicate events (`storage.events`, `storage.duplicateEvent`). `holqa storage put --json` reports `HOLQA_CLI_NOT_IMPLEMENTED`. See the [runtime reference](../../docs/reference/runtime.md#object-events) and the [local environment reference](../../docs/reference/local.md).

## Workflow

1. **Declare the bucket** with an explicit `id` and `access` (`"private"` unless the content is truly public).
2. **Upload directly from clients with signed URLs** issued by an authenticated server handler, scoped to a key prefix the server chooses.
3. **Read and write from handlers** using the portable operations on the bucket handle.
4. **React to events** with an object-created or object-deleted handler, filtered by prefix.
5. **Validate object metadata** (size, content type, key) in the event handler before processing.
6. **Exercise it locally** with `@holqa/local` (filesystem-backed); `holqa storage put` is proposed.

```ts
// src/uploads/request-upload.handler.ts — `requireUser` is illustrative middleware
import { z } from "zod";
import { resources } from "../../infra";
import { requireUser } from "../auth/require-user";

export default resources.api.route({
  id: "uploads.request",
  method: "POST",
  path: "/uploads",
  middleware: [requireUser],
  body: z.object({ contentType: z.enum(["image/png", "image/jpeg"]) }),
  responses: { 200: z.object({ url: z.url(), headers: z.record(z.string(), z.string()), key: z.string() }) },
  handler: async ({ body, context, reply }) => {
    const key = `incoming/${context.user.id}/${crypto.randomUUID()}`; // server-chosen key
    const signed = await resources.uploads.signedUrl(key, { method: "PUT", contentType: body.contentType, expiresInSeconds: 300 });
    return reply(200, { url: signed.url, headers: { ...signed.headers }, key });
  }
});
```

```ts
// src/uploads/on-upload.handler.ts — `markRejected` and `registerUpload` are illustrative
export default resources.uploads.onObjectCreated({
  id: "uploads.register",
  prefix: "incoming/",
  handler: async ({ object, event }) => {
    // Events arrive at least once and in no guaranteed order; `event.id` identifies duplicates.
    if (object.size > 25 * 1024 * 1024)
      return markRejected(object.key);            // idempotent upsert
    await registerUpload(object.key, object.size); // idempotent upsert
  }
});
```

## Pitfalls

- **Provider-specific APIs.** Do not import a vendor storage SDK into handlers; use the bucket handle so bindings stay portable. Missing capabilities must fail validation, not be emulated silently.
- **Client-chosen keys.** Letting clients pick keys enables overwriting other users' objects and path tricks. Generate keys on the server.
- **Trusting metadata.** Content type and size come from the uploader. Check them, and scan content if required.
- **Duplicate or out-of-order events.** Storage events are at-least-once and may arrive after a delete. Make handlers idempotent.
- **Long-lived signed URLs.** Keep expirations short and scoped to one key and operation.
- **Public buckets by default.** Use `access: "private"` and signed downloads unless content is meant to be public.
- **Deleting buckets.** Removing the declaration must never delete the bucket or its objects implicitly.

## Verification checklist

- [ ] The bucket has a stable `id` and the least permissive `access` that works.
- [ ] Signed URLs are issued only to authenticated callers, for server-chosen keys, with short expiry.
- [ ] Event handlers validate size, content type and key prefix.
- [ ] Event handlers produce the same result when run twice.
- [ ] No vendor storage SDK is imported in handler code.
