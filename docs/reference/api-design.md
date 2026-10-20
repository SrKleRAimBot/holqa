# API design specification

> **Status:** Partly implemented. The application definition, the `queue`, `bucket`, `schedule` and `http.api` declarations, configuration entries, typed handles, queue, bucket and schedule handler registration, HTTP routes with `reply`, RPC procedures, middleware, the descriptor protocol and the runtime binding contract are **Implemented** in `@holqa/core` and `@holqa/sdk`, with the differences listed under [implementation status](#implementation-status). Schema adapters are **Implemented** as described in [schema contracts](schema-contracts.md). `staticSite` and infrastructure bindings remain **Proposed**. The implemented HTTP, RPC and middleware APIs are specified in the [runtime reference](runtime.md). Parts marked **Validated in M0** were prototyped in the disposable [`experiments/`](../../experiments/README.md) packages, which are not part of the framework.

This page specifies the public APIs for application definitions, typed resources, handlers, schema adapters and bindings. It is the target for the first real implementation of `@holqa/sdk` and the descriptor contracts in `@holqa/core`. Decisions behind it are recorded in ADRs [0012](../architecture/decisions/0012-source-inferred-types-and-reply-helpers.md) to [0017](../architecture/decisions/0017-package-layers-after-m0.md). The [commerce example](../../examples/commerce/README.md) is the reference application written against it.

## Implementation status

| Area | Status | Differences from the M0 proposal on this page |
| --- | --- | --- |
| `defineApp`, `defineResources`, `App.env` | **Implemented** | `handlers` is optional and also accepts `{ include, exclude }`; `description` was added; `composeResources` was added. `defineApp` validates the whole definition and throws a `HolqaError` listing every problem, including duplicate identifiers ([ADR 0019](../architecture/decisions/0019-declaration-time-validation.md)). |
| `queue`, `bucket`, `schedule`, `secret`, `variable` | **Implemented** | Identifiers and options are validated when the factory is called, and literal identifiers at compile time. |
| `http.api` | **Implemented** | Accepts `middleware`. |
| `route(...)`, `reply` | **Implemented** | Adds a `headers` schema and route `middleware`; `reply(status, body, headers?)` as in ADR 0012; bodies are validated and sent in the schema's output form; a returned `Response` passes through for streaming; an undeclared status fails with `HOLQA_RESPONSE_INVALID` (not `HOLQA_DECLARATION_INVALID`). See the [runtime reference](runtime.md#http-routes). |
| `procedure(...)` | **Implemented** | `{ id, operation: "query" \| "mutation", input?, output, middleware?, handler }`, served with the `holqa.rpc/1` protocol ([ADR 0023](../architecture/decisions/0023-common-invocation-engine-and-http-rpc-execution.md)). |
| Middleware | **Implemented** | `middleware(...)`, `middleware.requires<Context>()`, application, API and route scopes. See [middleware](runtime.md#middleware). |
| Handler registrations `consume`, `onObjectCreated`, `handle` | **Implemented** | Registrations expose `trigger` (the trigger kind), `id` and `resourceId`. |
| Descriptor protocol | **Implemented** | Typed kind registries instead of open `config` objects; handler descriptors hold `definition` (JSON metadata) separately from `invoke`; resource descriptors add `requirements` ([ADR 0018](../architecture/decisions/0018-typed-kind-registries-in-the-descriptor-protocol.md)). |
| Runtime bindings | **Implemented** (contract only) | `RuntimeBinding` is `{ name, capabilities, drivers, config }`; `bindApp` checks capabilities and drivers before installing; rebinding fails with `HOLQA_RUNTIME_ALREADY_BOUND` ([ADR 0020](../architecture/decisions/0020-runtime-binding-resolution.md)). `@holqa/runtime-bun` installs a binding when it starts. |
| Schema adapters | **Implemented** | The method is `describe(schema, side)` and returns a description with structured `runtimeOnly` entries, or a problem with a `path` and `hint`. Fidelity is recorded on the normalized contract's `source`, not per conversion ([ADR 0021](../architecture/decisions/0021-schema-contracts-wire-payloads-and-compatibility.md)). |
| Infrastructure bindings | **Implemented** | Binding configurations (`defineBindings`), providers and composition ([binding contracts](bindings.md)). |
| `staticSite` | **Implemented** | `{ id, directory, basePath?, spa? }`: artifacts the frontend build wrote, not a build command ([ADR 0031](../architecture/decisions/0031-static-sites-as-a-resource-kind.md)). |

The [resource model](../architecture/resource-model.md) and the [packages reference](packages.md) describe the implemented API; this page keeps the original proposal for the parts that are not built.

## Design rules

| Rule | Consequence |
| --- | --- |
| Types are inferred from source, never generated, for code that can import `infra.ts`. | Factories use `const` type parameters and structural Standard Schema generics. **Validated in M0.** |
| Declarations are pure. | `defineApp` and every factory perform no I/O and read no clock, randomness or environment. Malformed declarations and duplicate resource identifiers throw when declared (**Implemented**); graph problems that involve handlers are compiler diagnostics (planned). |
| Every Holqa value carries a plain descriptor. | The compiler and runtime read descriptors and never import the SDK. **Validated in M0.** |
| Handles are operations, not infrastructure. | A handle delegates to a runtime binding. Using it with no binding fails with `HOLQA_RUNTIME_NOT_BOUND`. **Validated in M0.** |
| Producers send the schema's **input** type; consumers receive its **output** type. | The wire format is the input (encoded) representation. **Validated in M0.** |
| Responses are built with `reply(status, body)`. | Returned object literals lose their literal types in TypeScript. **Validated in M0.** |
| No provider configuration in declarations. | Requirements live on resources, capabilities on bindings ([ADR 0005](../architecture/decisions/0005-infrastructure-independent-resource-contracts.md)). |

## Application definition

The following code is illustrative. The API is proposed, not implemented, and may change.

```ts
// infra.ts
import { bucket, defineApp, http, queue, schedule, secret, variable } from "@holqa/sdk";
import { z } from "zod";

import { orderPlaced } from "./src/contracts";

const app = defineApp({
  name: "commerce",
  handlers: ["./src/**/*.handler.ts"],
  resources: {
    api: http.api({ id: "storefront-api", basePath: "/api" }),
    orders: queue({ id: "order-fulfillment", message: orderPlaced, schemaVersion: 1, delivery: { maxAttempts: 5, deadLetter: true } }),
    invoices: bucket({ id: "invoices", access: "private" }),
    reconciliation: schedule({ id: "nightly-reconciliation", cron: "0 3 * * *", timezone: "UTC", overlap: "skip" })
  },
  env: {
    PAYMENT_WEBHOOK_SECRET: secret(z.string().min(16)),
    CURRENCY: variable(z.enum(["EUR", "USD"]), { default: "EUR" })
  }
});

export default app;
export const resources = app.resources;
export const config = app.env;
```

| API | Signature (simplified) | Notes |
| --- | --- | --- |
| `defineApp` | `defineApp<const R, const E>(definition: { name; handlers: string[]; resources: R; env?: E }): App<R, E>` | Returns `{ name, resources: R, env: ConfigValues<E>, "~holqa": AppDescriptor }`. The default export of `infra.ts` is the application. **Validated in M0.** |
| `defineResources` | `defineResources<const R>(resources: R): R` | Identity function that gives a resource group a precise type so it can be spread into `defineApp`. **Validated in M0.** |
| `App.env` | `{ readonly [K in keyof E]: InferOutput<E[K]["schema"]> }` | Getters that read validated values from the binding. Reading at module top level fails with `HOLQA_RUNTIME_NOT_BOUND`. **Validated in M0.** |
| `handlers` | Glob patterns relative to `infra.ts` | Discovered by the host (CLI), not by `@holqa/sdk`. |

Resource handles constrain only `{ kind, id, "~holqa" }`. A stricter constraint rejects concrete handles, because handle operations are contravariant in their message types ([type inference experiment](../../experiments/sdk/README.md#findings)).

## Resource kinds

| Factory | Declares | Handle operations | Handler registration | Status (M0 evidence) |
| --- | --- | --- | --- | --- |
| `http.api({ id, basePath, docs? })` | Base path, documentation metadata | none | `route(...)`, `procedure(...)` (proposed) | Proposed (`route` prototyped in M0) |
| `queue({ id, message, schemaVersion, delivery? })` | Message schema and version; `maxAttempts`, `deadLetter` | `send(message: InferInput<S>)` | `consume({ id, concurrency?, handler })` | Proposed (prototyped in M0) |
| `bucket({ id, access })` | Access policy (`private`, `public-read`) | `put`, `get` (signed URLs proposed) | `onObjectCreated({ id, prefix?, handler })` (`onObjectDeleted` proposed) | Proposed (prototyped in M0) |
| `schedule({ id, cron, timezone, overlap })` | Cron, IANA timezone, overlap policy (`skip`, `allow`) | none | `handle({ id, handler })` | Proposed (prototyped in M0) |
| `staticSite({ id, root, build, spaFallback })` | Static assets | none | none | Proposed (not prototyped) |
| `secret(schema)`, `variable(schema, { default? })` | Configuration entries | read through `app.env` | none | Proposed (prototyped in M0) |

Identifiers follow the implemented `ResourceId` grammar. They are validated when declared, and `defineApp` reports every problem in a definition at once ([ADR 0019](../architecture/decisions/0019-declaration-time-validation.md)).

## Handlers

A handler module imports `infra.ts` and exports one or more registrations. `infra.ts` never imports handlers.

The following code is illustrative. The API is proposed, not implemented, and may change.

```ts
// src/orders/get-order.handler.ts
import { z } from "zod";

import { resources } from "../../infra";

export default resources.api.route({
  id: "orders.get",
  method: "GET",
  path: "/orders/:orderId",
  params: z.object({ orderId: z.uuid() }),
  responses: {
    200: z.object({ orderId: z.string(), status: z.enum(["pending", "paid"]) }),
    404: z.object({ message: z.string() })
  },
  handler: ({ params, reply }) => reply(404, { message: `Order ${params.orderId} does not exist.` })
});
```

### Handler contexts

| Registration | Context fields | Return |
| --- | --- | --- |
| `route` | `params`, `query`, `body`, `headers` (validated output types), `signal`, `log`, `reply` | `reply(status, body, headers?)` |
| `consume` | `message` (output type), `delivery: { attempt, messageId }`, `signal`, `log` | `void`. Throwing requests redelivery. |
| `onObjectCreated` | `object: { key, size, contentType? }` (portable), `signal`, `log` | `void` |
| `handle` (schedule) | `scheduledTime` (ISO 8601 string), `signal`, `log` | `void` |

Route typing rules, **validated in M0**:

- Without a `params` schema, path parameters are inferred from the template (`/stores/:storeId` gives `{ storeId: string }`). With one, the schema must declare exactly the template's parameters.
- `GET` and `DELETE` cannot declare `body`.
- `reply` accepts only declared statuses, and bodies of the matching schema's input type.
- Response bodies are validated against their schema before they leave the handler. An undeclared status at runtime fails with `HOLQA_DECLARATION_INVALID`.

### Types for consumers of declarations

| Type | Purpose | Status |
| --- | --- | --- |
| `QueueConsumerFor<typeof resources.orders>` | Types a consumer function written apart from its registration, through a type-only import. | **Validated in M0** |
| `QueueMessageInput<H>`, `QueueMessageOutput<H>` | The producer and consumer message types of a queue handle. | **Validated in M0** |
| `InferRouteContract<typeof route>` | The client-facing contract of a route: method, path, params, query, body input, and a status-discriminated response union. Usable through `import type` without bundling server code. | **Validated in M0** |

Generated browser clients remain the mechanism for consumers that cannot import application source ([type safety and schemas](../concepts/type-safety-and-schemas.md#generated-browser-safe-clients)).

## Descriptor protocol (`@holqa/core`)

Every SDK value carries a descriptor under the string key `~holqa`. A string key, rather than a `unique symbol`, keeps values compatible across duplicate package copies, as Standard Schema's `~standard` does. **Validated in M0** in `@holqa/experiment-model`.

| Descriptor | Fields |
| --- | --- |
| `AppDescriptor` | `protocol: 1`, `type: "app"`, `name`, `handlers`, `resources`, `config`, `binding` (slot) |
| `ResourceDescriptor` | `protocol`, `type: "resource"`, `kind`, `id`, `config` (JSON only), `schemas` (Standard Schemas by role, for example `message`) |
| `HandlerDescriptor` | `protocol`, `type: "handler"`, `id`, `trigger: { kind, resource, ... }` (JSON only), `config`, `schemas` (by role, for example `body`, `response.200`), `invoke(input, context)` |
| `ConfigDescriptor` | `protocol`, `type: "config"`, `name`, `sensitive`, `schema`, `defaultValue?` |

Trigger kinds used in M0: `http.route`, `queue.message`, `bucket.object-created`, `schedule.tick`. `invoke` receives untrusted input and validates it against `schemas` before user code runs. Consumers reject descriptors with an unknown `protocol` version.

## Schema adapters (`@holqa/core` contract, integration packages)

This is the original M0 proposal. The implemented contract differs as listed under [implementation status](#implementation-status); see [schema contracts](schema-contracts.md) for the implemented API.

```ts
export interface SchemaAdapter {
  readonly vendor: string; // Standard Schema vendor, for example "zod"
  readonly library: string; // exact library and version, recorded in the manifest
  readonly convert: (schema: StandardSchemaV1, side: "input" | "output") => Result<SchemaConversion, SchemaConversionFailure>;
}

export interface SchemaConversion {
  readonly jsonSchema: JsonObject; // JSON Schema draft 2020-12
  readonly fidelity: "verified" | "unverified";
  readonly runtimeOnly: readonly { readonly path: string; readonly kind: string; readonly detail: string }[];
}
```

**Validated in M0** for Zod 4.6 and Valibot 1.5, with string `runtimeOnly` entries and fidelity encoded in `library`. The structured form above is the M0 recommendation ([schema experiment](../../experiments/schema-adapters/README.md)). Runtime validation needs no adapter: it uses `~standard.validate` only, and always awaits it.

## Runtime bindings

A runtime binding connects handles to drivers for one loaded application instance. **Validated in M0** with in-memory drivers.

The following code is illustrative. The API is proposed, not implemented, and may change.

```ts
export interface RuntimeBinding {
  readonly queue: (resourceId: string) => { send(message: unknown): Promise<void> };
  readonly bucket: (resourceId: string) => { put(key: string, body: string | Uint8Array, options?: { contentType?: string }): Promise<void>; get(key: string): Promise<Uint8Array | undefined> };
  readonly config: (name: string) => unknown; // validated value
}

export function bindApp(app: AppDescriptor, binding: RuntimeBinding): () => void; // rejects rebinding
```

Each runtime generation evaluates its own module graph and binds its own application instance ([ADR 0015](../architecture/decisions/0015-runtime-generations-and-reload.md)).

## Infrastructure bindings

Infrastructure bindings (which driver backs which logical resource in an environment, and with which capabilities) are **Planned**. They were not prototyped in M0. The constraints from [infrastructure providers](../concepts/infrastructure-providers.md) apply: bindings live outside `infra.ts`, declare capabilities, and fail explicitly with `HOLQA_BINDING_CAPABILITY_UNSUPPORTED` when a requirement cannot be met. The runtime-binding contract above is the data-plane interface such drivers will implement.

## Programming-model rules found in M0

1. **No binding use at module top level.** Read `config` and use handles inside handlers, or behind a lazily created client. Module evaluation is how the compiler analyzes an application.
2. **No reliance on module state between invocations or generations.** Every reload creates a fresh module graph.
3. **Handlers must honor `signal`.** A handler that ignores cancellation keeps running after its caller has been told it was cancelled.
4. **Queue consumers must be idempotent.** Delivery is at least once.
5. **Transforms must be deterministic decoders.** The wire carries the input form, and every consumer decodes it again.
6. **Use `reply`.** Plain response object literals do not type-check without `as const`.

## Diagnostic codes proposed by M0

These codes are used by the experiments. The SDK and compiler codes in this table are now registered in `@holqa/core` (see [diagnostic codes](diagnostic-codes.md)), with `HOLQA_ROUTE_CONFLICT` in place of the proposed `HOLQA_ROUTE_AMBIGUOUS`; the runtime codes are registered when the runtime that emits them is implemented.

| Code | Meaning |
| --- | --- |
| `HOLQA_RESOURCE_ID_DUPLICATE`, `HOLQA_HANDLER_ID_DUPLICATE` | Two resources or two handlers share an identifier. |
| `HOLQA_RESOURCE_NOT_FOUND` | A trigger references an undeclared resource. |
| `HOLQA_QUEUE_CONSUMER_DUPLICATE` | A queue has more than one consumer. |
| `HOLQA_ROUTE_AMBIGUOUS` | Two routes have the same method and path shape. |
| `HOLQA_SCHEMA_UNSUPPORTED`, `HOLQA_SCHEMA_FIDELITY_UNVERIFIED`, `HOLQA_SCHEMA_RUNTIME_ONLY` (suggested) | Schema normalization outcomes. |
| `HOLQA_INPUT_INVALID` | Input failed validation at a trust boundary. |
| `HOLQA_RUNTIME_NOT_BOUND` | A handle or configuration value was used without a runtime. |
| `HOLQA_CONFIG_INVALID` | Configuration failed validation at load. |
| `HOLQA_DECLARATION_INVALID` | A malformed declaration. |
| `HOLQA_MODULE_EVALUATION_FAILED` | An application module threw while being loaded. |
| `HOLQA_HANDLER_NOT_FOUND`, `HOLQA_INVOCATION_CANCELLED`, `HOLQA_RUNTIME_DISPOSED`, `HOLQA_RELOAD_FAILED` | Runtime lifecycle outcomes. |

## Open questions

| Question | Where it is tracked |
| --- | --- |
| How the CLI obtains schema adapters (declared in `defineApp`, a tool configuration file, or resolved by vendor name). | [Backlog](../milestones/m0/backlog.md) |
| RPC `procedure` shape and query/mutation classification. | Resolved by [ADR 0023](../architecture/decisions/0023-common-invocation-engine-and-http-rpc-execution.md) |
| Middleware typing (context extension at application, API and route level). | Resolved by [ADR 0023](../architecture/decisions/0023-common-invocation-engine-and-http-rpc-execution.md) |
| Whether `send` validates by default (it does in M0). | Backlog |
| Infrastructure binding file format and capability vocabulary. | [ADR 0005](../architecture/decisions/0005-infrastructure-independent-resource-contracts.md), backlog |

## Related

- [M0 summary](../milestones/m0/index.md)
- [Application model](../concepts/application-model.md)
- [Triggers and execution](../concepts/triggers-and-execution.md)
- [Package boundaries](../architecture/package-boundaries.md)
