# Effect

> **Status:** Planned. No Effect integration exists. All code on this page is illustrative; the API is proposed and may change.

[Effect](https://effect.website/) is a TypeScript library for typed errors, dependency injection, concurrency, and schemas. Holqa plans to support Effect in three roles, delivered through `packages/integrations/effect` (final npm name not decided).

| Role | Integration category | Purpose |
| --- | --- | --- |
| Effect Schema | Schema adapter | Use Effect Schema for resource and contract schemas. |
| Effect handlers | Handler adapter | Write handlers as Effect programs instead of async functions. |
| Effect HTTP | HTTP/transport adapter | Implement Holqa HTTP resources with Effect's HTTP platform. |

## Effect Schema

Effect Schema distinguishes encoded (wire) and decoded (application) types explicitly. That matches Holqa's need to infer both the input type producers send and the output type consumers receive ([type safety and schemas](../concepts/type-safety-and-schemas.md)). The adapter would produce Holqa's normalized representation from the encoded side and report constructs it cannot normalize with an explicit diagnostic. See [schema libraries](schema-libraries.md).

## Effect handlers

Native async functions remain the default handler style. An Effect adapter would let a handler return an `Effect` instead of a `Promise`:

```ts
// Illustrative, proposed API.
import { Effect } from "effect";
import { effectHandler } from "@holqa/effect"; // package name not decided
import { resources } from "../../infra";

export default resources.orders.consume({
  id: "orders.process",
  handler: effectHandler(({ message }) =>
    Effect.gen(function* () {
      const repo = yield* OrderRepository;
      yield* repo.markProcessing(message.orderId);
    }).pipe(Effect.provide(OrderRepositoryLive))
  )
});
```

Design considerations:

- **Error mapping.** Typed Effect failures must map to Holqa outcomes: for queues, failure leads to retry according to the delivery policy; for HTTP, failures map to declared status-specific responses.
- **Interruption.** Holqa's invocation lifecycle (timeouts, shutdown during reload) should interrupt the running fiber.
- **Layers.** Long-lived services (database pools) should be built once per execution environment, not once per invocation, while respecting the rule that handlers do not rely on in-memory state for correctness.
- **No core dependency.** `@holqa/core` and `@holqa/sdk` must not import Effect. The adapter depends inward only ([package boundaries](../architecture/package-boundaries.md)).

## Effect HTTP

Teams that build APIs with Effect's HTTP platform should be able to mount them as the implementation of a Holqa `http.api` resource, similar to [Hono and oRPC](orpc-and-hono.md). Holqa would still own the resource identity, routing prefix, and manifest entry; Effect would own request handling within it. How much contract information (for OpenAPI and generated clients) can be extracted from an Effect HTTP API is an open question.

## Related

- [Integrations](index.md)
- [Schema libraries](schema-libraries.md)
- [Triggers and execution](../concepts/triggers-and-execution.md)
