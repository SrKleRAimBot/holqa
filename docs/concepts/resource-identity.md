# Resource identity

> **Status:** Implemented — identifier grammar, declaration-time validation, duplicate resource detection in `defineApp` (run time and compile time), and duplicate handler detection in the compiler (`holqa inspect`, `holqa build --manifest`). Tracking identities across deployments is **Planned**.

Every resource and every handler in a Holqa application has an explicit, stable identifier, its `id`. The identifier is the persistent identity of the logical resource: it ends up in descriptors, diagnostics and the manifest, and in the future in logs and physical resource names. The object key a handle is stored under is only a local alias. See [ADR 0004](../architecture/decisions/0004-stable-logical-resource-identities.md) for the reasoning.

## Rules

| Rule | Enforced by | Diagnostic |
| --- | --- | --- |
| Every resource, handler and application has an explicit identifier. There is no default from a property name or file path. | Required `id` (and `name`) options in the SDK types | Compile error; `HOLQA_RESOURCE_ID_INVALID` at run time when missing |
| Identifiers match `^[a-z][a-z0-9]*(?:[-.][a-z0-9]+)*$` and are 1 to 63 characters long. | `parseResourceId`; literal identifiers also at compile time | `HOLQA_RESOURCE_ID_INVALID` |
| Resource identifiers are unique within an application, across every module that contributes resources. | `defineApp`; literal identifiers also at compile time | `HOLQA_RESOURCE_ID_DUPLICATE` |
| A resource handle belongs to exactly one application instance. | `defineApp` | `HOLQA_DECLARATION_INVALID` |
| Handler identifiers are unique within an application. | The compiler, after discovering handler modules (`holqa inspect`, `holqa build --manifest`) | `HOLQA_HANDLER_ID_DUPLICATE` |
| Configuration entry names are their keys in `env` (for example `DATABASE_URL`). This is the one deliberate exception to "keys are only aliases": names map to environment variables, so renaming one is a breaking change for every environment that supplies it. | `defineApp` checks the name grammar | `HOLQA_DECLARATION_INVALID` |
| Aliases (object keys) are unique within one record. | JavaScript object semantics; `composeResources` rejects aliases declared by two groups | Compile error, `HOLQA_DECLARATION_INVALID` |

The grammar is an initial proposal and may change before 1.0. Lowercase letters, digits and single `-` or `.` separators keep identifiers usable in DNS labels, file names and most naming schemes; `.` lets handler identifiers be namespaced, as in `orders.process`.

## Alias versus identity

The following code uses the implemented `@holqa/sdk` API.

```ts
import { defineApp, queue } from "@holqa/sdk";
import { z } from "zod";

const app = defineApp({
  name: "commerce",
  resources: {
    // `orders` is the alias: rename it freely.
    // "order-processing" is the identity: changing it is an identity change.
    orders: queue({ id: "order-processing", message: z.object({ orderId: z.string() }), schemaVersion: 1 })
  }
});

app.resources.orders.id; // type: "order-processing"
```

| Change | Effect |
| --- | --- |
| Rename the alias `orders` to `orderQueue` | A TypeScript refactor. Same resource. |
| Move the declaration to another module | Same resource. |
| Change `id: "order-processing"` | A different logical resource: the old one is no longer used. Future tooling must report this and must never delete data because of it. |

## Compile-time checks

Literal identifiers are checked while code is being written. A failed check makes the argument require a `~holqaTypeError` property whose type is the message:

```text
Argument of type '{ id: "Orders"; ... }' is not assignable to parameter of type 'QueueOptions<"Orders", ...> & HolqaTypeError<"Invalid identifier \"Orders\": it must start with a lowercase letter.">'.
```

The same mechanism reports duplicate literal identifiers in `defineApp({ resources })`:

```text
... HolqaTypeError<"Resource identifier \"same\" is declared more than once. Every resource needs its own id.">
```

Identifiers typed as plain `string` (computed at run time) cannot be checked statically; the run-time checks still apply. Both outputs above were produced by `tsc` against the implemented SDK; the argument types are abbreviated.

## Run-time checks

Factories validate their own declaration when called, and `defineApp` validates the whole application. Each throws one `HolqaError` whose `diagnostics` list every problem found, so one run reports all of them. Duplicates name every alias involved, for example `The resource identifier "orders" is declared more than once: resources.orders, resources.orderQueue.`

## Related

- [Application model](application-model.md)
- [Composing applications](composing-applications.md)
- [Diagnostic codes](../reference/diagnostic-codes.md)
- [ADR 0019: Declaration-time validation](../architecture/decisions/0019-declaration-time-validation.md)
