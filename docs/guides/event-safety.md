# Event safety guide

> **Status:** **Implemented** in the private, unpublished packages; every command and API on this page runs today. The examples come from [`examples/event-safety`](../../examples/event-safety/README.md).

This guide shows how to find event cycles before running an application, how to keep intentional cycles bounded, which runtime limits stop runaway chains, how to make handlers idempotent, and how to test all of it. The concepts are in [event safety](../concepts/event-safety.md).

## Find cycles

`holqa inspect --cycles` analyzes the application and prints its event graph and cycles:

```sh
holqa inspect --cycles --app app/infra.ts
```

For the example application, the output is:

```text
app/src/reminders.handler.ts:22:11 warning HOLQA_EVENT_CYCLE: Event cycle: followups.send → reminders.send() → reminders.send → resources.followups.send() → followups.send. The handlers "followups.send", "reminders.send" may publish events that trigger each other.
  hint: Add a termination condition, or bound the chain with events.maxDepth on the handler or the runtime's event limits. If the cycle is intentional, declare events: { cycle: { justification } } on one of its handlers.
Event graph of "event-safety"

Handlers (5)
  followups.send  queue.message <- "followups"  analysis complete
    send "reminders"  known  reminders.send()  app/src/reminders.handler.ts:22:11
  images.thumbnail  object.created <- "images" (prefix "uploads/")  analysis complete
    put "images"  known  resources.images.put()  app/src/images.handler.ts:14:13
  payments.charge  queue.message <- "payments"  analysis complete
  reminders.send  queue.message <- "reminders"  analysis complete
    send "followups"  known  resources.followups.send()  app/src/reminders.handler.ts:13:11
  shipments.fulfil  queue.message <- "shipments"  analysis complete  maxDepth 10
    send "shipments"  known  resources.shipments.send()  app/src/shipments.handler.ts:25:11

Cycles (1 reported, 1 allowed)
  warning  known      followups.send → reminders.send() → reminders.send → resources.followups.send() → followups.send
             at app/src/reminders.handler.ts:22:11
  allowed  known      shipments.fulfil → resources.shipments.send() → shipments.fulfil
             at app/src/shipments.handler.ts:25:11
             allowed by shipments.fulfil: Each check increments checks; after maxStockChecks the shipment is given up.

Cycles may terminate; the compiler cannot prove it. Runtime limits (depth, publications, operation budgets) stop chains that do not.
```

The warning goes to standard error; the report to standard output. The exit code is `0`: cycles are findings, and `holqa inspect` and `holqa build --manifest` still succeed. With `--json`, standard output is one document `{ cycles, diagnostics, events }`; see the [CLI reference](../reference/cli.md#holqa-inspect).

`images.thumbnail` writes into the bucket that triggers it, but only receives keys under `uploads/` and writes under `thumbnails/`, so analysis knows that it cannot trigger itself.

## Declare what analysis cannot see

When a handler publishes through code analysis cannot follow (a library that receives the handle, a value chosen at run time), the call is listed under "Unresolved publications". Declare the targets:

```ts
export const forward = resources.inbox.consume({
  id: "inbox.forward",
  events: { publishes: [resources.outbox] },
  handler: async ({ message }) => {
    await router.dispatch(message);
  }
});
```

Declared publications are `known` edges, in addition to what analysis finds.

## Keep an intentional cycle bounded

A handler that requeues itself until it reaches a terminal state is a legitimate cycle. Declare it with a justification, and give it an explicit bound:

```ts
export const fulfilShipment = resources.shipments.consume({
  id: "shipments.fulfil",
  events: { cycle: { justification: "Each check increments checks; after maxStockChecks the shipment is given up." }, maxDepth: 10 },
  handler: async ({ message }) => {
    if (inStock.has(message.orderId) || message.checks + 1 >= maxStockChecks)
      return;
    await resources.shipments.send({ orderId: message.orderId, checks: message.checks + 1 }, { delaySeconds: 60 });
  }
});
```

The justification (at most 500 characters) appears in `inspect --cycles`. It only allows cycles through this handler: other cycles are still reported. `maxDepth: 10` stops the chain at run time if the termination condition ever breaks. `context.lineage.depth` is available in the handler for conditions that count hops.

## Set runtime limits

Every runtime refuses events deeper than 16 hops and invocations that publish more than 1000 events. Change the defaults, and add an event age limit or a per-operation budget, with `events` on `createRuntime` or `createTestApp`:

```ts
const runtime = createRuntime({
  app,
  handlers,
  binding: local.binding,
  events: { maxDepth: 8, maxPublications: 100, maxEventAgeMs: 3_600_000, maxEventsPerOperation: 10_000 }
});
```

`maxEventsPerOperation` needs a binding with atomic, shared accounting. The local binding has it; on a binding without it the runtime refuses to start with `HOLQA_BINDING_CAPABILITY_UNSUPPORTED` rather than enforce it partially. Handlers override `maxDepth` and `maxPublications` with their own `events` option. `holqa dev` runs with the defaults.

A refused publication throws in the handler (`HOLQA_EVENT_DEPTH_EXCEEDED`, `HOLQA_EVENT_PUBLICATION_LIMIT_EXCEEDED` or `HOLQA_EXECUTION_BUDGET_EXCEEDED`), and the delivery that ran it is dead-lettered at once instead of retried, with the guard's code as its last error:

```sh
holqa state --app app/infra.ts
```

## Make handlers idempotent

```ts
export const chargePayment = resources.payments.consume({
  id: "payments.charge",
  idempotency: { key: ({ message }) => message.paymentId, retentionSeconds: 86_400 },
  handler: async ({ message }) => {
    await payments.charge(message.paymentId, message.amountCents, { idempotencyKey: message.paymentId });
  }
});
```

`payments` stands for your payment service's client. `idempotency: true` keys on the message identifier. Deliveries whose key already completed are acknowledged without running the handler. This does not make the side effect exactly-once: if the handler fails after charging, the retry charges again, which is why the call above also passes the key to the payment service. See [idempotency](../concepts/event-safety.md#idempotency).

## Replay dead letters

List what a redrive would do, then redrive:

```sh
holqa queue redrive reminders --dry-run --app app/infra.ts
holqa queue redrive reminders --limit 10 --app app/infra.ts
holqa queue redrive reminders --new-operation --app app/infra.ts
```

Redriven messages keep their lineage unless `--new-operation` starts a fresh root for each, so a message refused for its depth is refused again until you fix the cycle.

## Test

`createTestApp` runs the application on the local binding with a virtual clock, so the limits and the idempotency store work as under `holqa dev`:

```ts
const app = await createTestApp({ app: infra, handlers, events: { maxDepth: 6 } });
await app.send("reminders", { customerId: "c-1", count: 0 });
await app.drain();
const last = app.invocations({ handlerId: "reminders.send" }).at(-1)!;
expect(app.lineage(last.invocationId).map(record => record.depth)).toEqual([0, 1, 2, 3, 4, 5, 6]);
expect(app.deadLetters("reminders")[0]?.lastError?.code).toBe("HOLQA_EVENT_DEPTH_EXCEEDED");
```

A test that runs into an unbounded cycle fails with `HOLQA_SIMULATION_BUDGET_EXCEEDED` after `maxInvocations` (default 10 000) instead of hanging; the message names the busiest handlers and the deepest chain.

## Related

- [Event safety](../concepts/event-safety.md)
- [CLI reference](../reference/cli.md)
- [Runtime reference](../reference/runtime.md#event-lineage-and-limits)
- [Local development guide](local-development.md)
