# @holqa/bindings

Binding configurations for Holqa: select which provider fulfils each resource and service of an application, resolve
the selection deterministically, and compose it into the one runtime binding a runtime installs.

> **Status:** Implemented, private and unpublished. The API may change before the first release.

```ts
import { defineBindings } from "@holqa/bindings";
import app from "./infra";

export default defineBindings(app, {
  name: "staging",
  defaults: platform,             // a platform provider
  kinds: { queue: brokerQueues }, // every queue
  resources: { "audit-log": auditQueue }
});
```

`platform`, `brokerQueues` and `auditQueue` stand for provider objects created by provider factories.

| Export | Purpose |
| --- | --- |
| `defineBindings(app, config)` | Declares selections; pure and type-checked against the application. |
| `resolveBindings(definition)` | Resolves selections (resource, then kind, then default) and services, reporting every problem. |
| `createBinding(resolved)` | Composes a resolution into a `RuntimeBinding` whose lifecycle the runtime drives. |
| `environmentConfig()` | Configuration and credentials from environment variables. |

See the [binding contracts reference](../../docs/reference/bindings.md) and
[ADR 0030](../../docs/architecture/decisions/0030-binding-composition-and-resolution.md). The package depends on
`@holqa/core` only and is runtime-neutral.
