import {
  defineApp,
  http,
  queue
} from "@holqa/sdk";
import { stringRecord } from "@test/support/schemas";

/** A message with an identifier and a step counter, as strings. */
const step = stringRecord("id", "step");

/** Redelivery settings shared by the fixture's queues: three attempts, one second apart, dead-lettered. */
const delivery = { maxAttempts: 3, deadLetter: true, backoff: { strategy: "fixed" as const, delaySeconds: 1 } };

/**
 * Event-driven handlers that misbehave on purpose: a consumer that requeues
 * itself forever, one that fans out, one that publishes too much, and one
 * that requeues itself until it is done, plus an idempotent consumer with a
 * side effect.
 */
const app = defineApp({
  name: "loops",
  handlers: [],
  resources: {
    api: http.api({ id: "loops-api", basePath: "/api" }),
    loop: queue({ id: "loop", message: step, schemaVersion: 1, delivery }),
    fanout: queue({ id: "fanout", message: step, schemaVersion: 1, delivery }),
    retry: queue({ id: "retry", message: step, schemaVersion: 1, delivery }),
    burst: queue({ id: "burst", message: step, schemaVersion: 1, delivery }),
    sink: queue({ id: "sink", message: step, schemaVersion: 1, delivery }),
    wrapped: queue({ id: "wrapped", message: step, schemaVersion: 1, delivery }),
    payments: queue({ id: "payments", message: step, schemaVersion: 1, delivery })
  }
});

export default app;

/** The typed handles. */
export const resources = app.resources;

/**
 * Builds the next message of a chain.
 *
 * @param message - The current message.
 * @param message.id - Its identifier.
 * @param message.step - Its step, as a decimal string.
 * @returns The message one step further.
 */
function next(message: { readonly id: string; readonly step: string }): { readonly id: string; readonly step: string } {
  return { id: message.id, step: String(Number(message.step) + 1) };
}

/** Requeues every message forever: a runaway self-cycle. */
export const loop = resources.loop.consume({
  id: "loop.run",
  handler: async ({ message }) => {
    await resources.loop.send(next(message));
  }
});

/** Sends two messages for every message it receives: a branching storm. */
export const fanout = resources.fanout.consume({
  id: "fanout.run",
  handler: async ({ message }) => {
    await resources.fanout.send(next(message));
    await resources.fanout.send(next(message));
  }
});

/** Requeues work until it reaches step 5: an intentional, terminating cycle. */
export const retry = resources.retry.consume({
  id: "retry.run",
  events: { cycle: { justification: "Each message moves one step towards step 5 and stops there." } },
  handler: async ({ message }) => {
    if (Number(message.step) < 5)
      await resources.retry.send(next(message));
  }
});

/** Publishes three messages although it may publish two. */
export const burst = resources.burst.consume({
  id: "burst.run",
  events: { maxPublications: 2 },
  handler: async ({ message }) => {
    for (const index of ["1", "2", "3"])
      await resources.sink.send({ id: `${message.id}-${index}`, step: "0" });
  }
});

/** Receives what `burst.run` publishes. */
export const sink = resources.sink.consume({ id: "sink.run", handler: () => {} });

/** Requeues forever and replaces the guard's error with its own. */
export const wrapped = resources.wrapped.consume({
  id: "wrapped.run",
  handler: async ({ message }) => {
    try {
      await resources.wrapped.send(next(message));
    } catch {
      throw new Error("could not requeue");
    }
  }
});

/** Charges recorded by {@link payments}: a stand-in for an external side effect. */
export const charges: string[] = [];

/** Message identifiers whose first charge attempt fails after the side effect. */
export const flaky = new Set<string>();

/**
 * Charges each payment once per delivery key. A charge whose attempt fails
 * after the side effect is charged again on retry: idempotency suppresses
 * duplicate deliveries, not repeated side effects.
 */
export const payments = resources.payments.consume({
  id: "payments.charge",
  idempotency: { key: ({ message }) => message.id },
  handler: async ({ message, delivery: { attempt } }) => {
    charges.push(`${message.id}#${attempt}`);
    if (flaky.has(message.id) && attempt === 1)
      throw new Error("the connection dropped after the charge");
  }
});

/** Starts a fan-out over HTTP. */
export const start = resources.api.route({
  id: "loops.start",
  method: "POST",
  path: "/start",
  body: stringRecord("id"),
  responses: { 202: stringRecord("id") },
  handler: async ({ body, reply }) => {
    await resources.fanout.send({ id: body.id, step: "0" });
    return reply(202, { id: body.id });
  }
});

/** Every handler of the fixture. */
export const handlers = [loop, fanout, retry, burst, sink, wrapped, payments, start];