# Type inference experiment

> **Status:** Disposable M0 experiment — not part of the framework.

## Question

Can an `infra.ts` resource declaration preserve exact schema types through `defineApp`, resource handles, and separately defined handler modules, without generated types?

## Method

| Part | What it does |
| --- | --- |
| `src/` | A prototype SDK: `defineApp`, `defineResources`, `queue`, `http.api` with `route`, `bucket`, `schedule`, `secret`, `variable`. Every factory returns a typed handle that also carries a plain descriptor (`~holqa`) from `@holqa/experiment-model`. Generics are built on structural Standard Schema types; the SDK imports no schema library. |
| `tests/fixtures/shop/` | A multi-file application: schemas in `catalog/schemas.ts`, a resource group in `catalog/resources.ts` spread into `defineApp`, and handlers in `handlers/*.ts` that import `infra.ts`. |
| `tests/app.inference.test.ts` | Positive `expectTypeOf` assertions and `@ts-expect-error` negative tests, enforced by `tsc --noEmit`. |
| `tests/app.test.ts`, `tests/resources/*.test.ts` | Runtime behavior: purity, unbound use, validation at trust boundaries, bindings. |
| `bench/type-scale.ts` | Generates an application with N queues, N routes and N consumers in separate modules that import the **built** SDK by package name, then runs `tsc --extendedDiagnostics`. |
| [`examples/commerce`](../../examples/commerce/README.md) | The reference application, type-checked against this package's built `dist/` declarations. |

Versions: TypeScript 6.0.3, Zod 4.6.7, Bun 1.3.13 (arm64, macOS).

## Results

### What inference preserves

All of the following are asserted in `tests/app.inference.test.ts` and pass `tsc --noEmit`. The commerce example uses the same patterns through the built declarations.

| Property | Result |
| --- | --- |
| Literal resource and handler identifiers (`"order-placed"`, `"orders.process"`) | Preserved through `const` type parameters. |
| Producer type = schema **input**, consumer type = schema **output** | `send` accepts an ISO string for a `z.iso.datetime().transform(...)` field; the consumer receives a `Date`. Defaulted fields are optional for producers and required for consumers. |
| Schemas imported from other modules, branded types | Preserved. The brand is visible on the output side only. |
| Resource groups declared in other files (`defineResources` + spread) | Preserved. |
| Configuration (`secret`, `variable`, `z.coerce`) | `app.env.PORT` is `number`, enums stay literal unions. |
| Handlers defined apart from their registration | `QueueConsumerFor<typeof resources.orders>` types a standalone function through a type-only import. |
| HTTP path parameters | Inferred from the template (`/stores/:storeId/items/:itemId`), or checked against a `params` schema that must declare exactly those keys. |
| Client contracts without code generation | `InferRouteContract<typeof route>` yields method, path, params, body input and a status-discriminated response union, through `import type` only. |
| Hand-written Standard Schemas | Accepted; non-schemas are rejected at compile time and at declaration time. |
| Wrong message shapes, excess literal properties, unknown resources, `GET` with a body, undeclared statuses, wrong response bodies | All rejected at compile time. |

Runtime tests: 24 pass, 0 fail (`bun test`).

### Literal widening in handler return values

This is the most important limitation the experiment found. When a handler **returns an object literal** whose expected type depends on a type parameter inferred from a sibling property of the same call (`responses`), TypeScript widens its literals: `status: 200` becomes `number` and `"pending"` becomes `string`. The handler is then rejected even though it is correct.

Nine formulations were compared in scratch files with `tsc --strict` (and confirmed under the repository tsconfig):

| Formulation | Literals preserved? |
| --- | --- |
| Single options object, handler returns `{ status, body }` | No |
| Same, with `NoInfer` on the return type | No |
| Same, with a `const` type parameter for `responses` | No |
| Same, with `handler` declared as a method | No |
| Same, with a distributive conditional response type | No |
| Same, with the return type as its own type parameter | No |
| Declaration and handler as two arguments of one call | No |
| **Two calls: `route({ ...declaration }).handle(fn)`** | **Yes** |
| **Single object, handler builds responses with `context.reply(status, body)`** | **Yes** |

The prototype uses `reply(status, body)`, which keeps one declaration object (the shape the compiler reads) and gives precise errors for wrong statuses and bodies. Returning `({ status: 200, body }) as const` also works. The same limitation applies to any future API whose handler return type is derived from sibling declarations, such as RPC outputs.

### Type-checking cost

`bun bench/type-scale.ts 1 10 50 200` (each N means N queues, N routes and N consumers, every handler in its own module):

| N | Check time | Total time | Types | Instantiations | Memory |
| --- | --- | --- | --- | --- | --- |
| 1 | 0.06 s | 0.19 s | 2,294 | 3,972 | 47 MB |
| 10 | 0.15 s | 0.28 s | 5,435 | 20,136 | 62 MB |
| 50 | 0.37 s | 0.51 s | 19,395 | 91,976 | 82 MB |
| 200 | 1.05 s | 1.32 s | 71,745 | 361,376 | 179 MB |

Cost grows linearly, at about 1,800 instantiations per queue, route and consumer, most of them from Zod's own types. No exponential case was found. Editor latency was not measured.

### Declarations

- `tsc --declaration --emitDeclarationOnly` on a generated application succeeds. The emitted `infra.d.ts` refers to `import("@holqa/experiment-sdk").QueueHandle<"queue-0", z.ZodObject<...>>`. No TS2742 ("cannot be named") error occurred with pnpm's layout, because the application depends on both `zod` and the SDK directly.
- `--isolatedDeclarations` is **incompatible** with inferred handler exports: every `export const route = resources.api.route(...)` fails with TS9010. Applications that enable it would have to annotate handler types by hand, which defeats inference.

## Findings

1. **The programming model works without generated types.** Exact schema types flow from `infra.ts` into separately defined handler modules, including imported schemas, resource groups from other files, transforms, defaults and brands. Inference works through built `.d.ts` files as well as through source.
2. **Literal widening is a real TypeScript limitation, not a prototype bug.** Handler APIs must build responses through a typed helper (`reply`) or a two-step builder. Plain returned object literals cannot be supported for status-discriminated responses.
3. **Ambient handles imported from `infra.ts` need a runtime binding.** Handles and `app.env` work only after a runtime binds the application. Used during module evaluation (for example `new Pool(config.DATABASE_URL)` at top level), they fail with `HOLQA_RUNTIME_NOT_BOUND`. This keeps `infra.ts` analyzable, but the existing illustrative `examples/basic-backend/src/db.ts` pattern must become lazy.
4. **Generic constraints must be structural.** A constraint such as `QueueHandle<string, StandardSchemaV1>` rejects concrete handles, because `send` is contravariant in its message type. `defineApp` constrains resources only by `{ kind, id, "~holqa" }`.
5. **Static types catch less than they appear to.** Excess-property checks apply only to object literals, and Zod's `z.object` silently strips unknown keys at runtime. Graph-level rules (unique identifiers across files, one consumer per queue) cannot be expressed in types and belong to the compiler.
6. **Type errors from validation types are hard to read.** The `params` exactness check reports a missing `"~error"` property. Readable errors need deliberate design, for example branded error-message types.
7. **Tooling details.** Bun's runtime `expectTypeOf` does not implement `.parameter()` (use `Parameters<...>`). TypeScript 6 refuses file arguments when a `tsconfig.json` is present (TS5112) unless `--ignoreConfig` is passed.

## Recommendation

- Accept source-based inference with structural Standard Schema generics for `@holqa/sdk` ([ADR 0012](../../docs/architecture/decisions/0012-source-inferred-types-and-reply-helpers.md)).
- Build responses through `context.reply(status, body)` in route and procedure handlers. Document `as const` as the escape hatch.
- Keep a type-level test corpus like `tests/app.inference.test.ts` for every resource kind, and run a scale benchmark in CI before 1.0.
- Document that `isolatedDeclarations` is unsupported for application code that declares resources and handlers.

## What is disposable

Everything in this package. The real `@holqa/sdk` should be written fresh from the [API design specification](../../docs/reference/api-design.md). It may reuse the type patterns validated here, but not the code as is.
