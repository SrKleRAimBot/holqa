import type {
  BucketDriver,
  DriverOperationContext,
  QueueDriver,
  ResourceDescriptorOf,
  RuntimeBinding,
  TelemetryAttributes
} from "@holqa/core";

import type { EventGuard } from "@/dispatch/event-guard";
import type {
  ActiveInvocation,
  InvocationTracker
} from "@/dispatch/invocation-tracker";
import type { RuntimeTelemetry } from "@/telemetry/runtime-telemetry";
import type { ActiveSpan } from "@/telemetry/tracer";

import { childTrace } from "@holqa/core";

/**
 * Wraps a binding's queue and bucket drivers so that every send, write and
 * delete performed by handler code is first admitted by the event guard
 * (publication, depth and operation budget limits), then carries the running
 * invocation's trace and lineage (`correlationId`, its `invocationId` as
 * `causationId`, the root operation and one more hop of depth) and, when
 * telemetry is recorded, the `traceparent` of a producer or client span
 * that is a child of the invocation's span, and is recorded as something
 * the invocation emitted. Operations outside an invocation pass through
 * unchanged. Capabilities, sources and configuration are not touched.
 *
 * @param binding - The binding the runtime installs.
 * @param tracker - Knows which invocation is running.
 * @param guard - Applies the event limits.
 * @param telemetry - Records the operations' spans.
 * @returns A binding with traced drivers.
 */
export function traceBinding(binding: RuntimeBinding, tracker: InvocationTracker, guard: EventGuard, telemetry: RuntimeTelemetry): RuntimeBinding {
  const { queue, bucket } = binding.drivers;
  const tracing: Tracing = { tracker, guard, telemetry };
  return Object.freeze({
    ...binding,
    drivers: Object.freeze({
      ...binding.drivers,
      ...queue === undefined ? {} : { queue: (resource: ResourceDescriptorOf<"queue">) => traceQueue(resource.id, queue(resource), tracing) },
      ...bucket === undefined ? {} : { bucket: (resource: ResourceDescriptorOf<"bucket">) => traceBucket(resource.id, bucket(resource), tracing) }
    })
  });
}

/** What the wrapped drivers use. */
interface Tracing {
  readonly tracker: InvocationTracker;
  readonly guard: EventGuard;
  readonly telemetry: RuntimeTelemetry;
}

/**
 * Builds the driver context of an operation from the running invocation.
 *
 * @param active - The running invocation, if any.
 * @param given - A context the caller already passed; it wins.
 * @param span - The operation's span, whose context the published event carries.
 * @returns The context, or `undefined` outside an invocation.
 */
function contextOf(active: ActiveInvocation | undefined, given: DriverOperationContext | undefined, span: ActiveSpan | undefined): DriverOperationContext | undefined {
  if (given !== undefined)
    return given;
  return active === undefined ? undefined : { trace: childTrace(active.lineage, active.invocationId, span?.traceparent) };
}

/**
 * Runs one resource operation of handler code inside a child span of the
 * invocation's span. Outside an invocation, or without telemetry, it just runs.
 *
 * @param tracing - The tracker and telemetry.
 * @param active - The running invocation, if any.
 * @param name - The span's name, for example `send orders`.
 * @param kind - `producer` for publishing, `client` for storage calls.
 * @param attributes - The span's attributes.
 * @param work - The operation; receives the span to propagate its context.
 * @returns What the operation returns.
 */
async function traced<Result>(tracing: Tracing, active: ActiveInvocation | undefined, name: string, kind: "producer" | "client", attributes: TelemetryAttributes, work: (span: ActiveSpan | undefined) => Promise<Result>): Promise<Result> {
  const parent = active?.span;
  const span = parent === undefined ? undefined : tracing.telemetry.startSpan({ name, kind, parent: parent.context, attributes });
  try {
    return await work(span);
  } catch (error) {
    span?.recordException(error);
    span?.setStatus({ code: "error", message: error instanceof Error ? error.message : String(error) });
    throw error;
  } finally {
    span?.end();
  }
}

/**
 * Wraps one queue driver.
 *
 * @param resourceId - The queue's identifier.
 * @param driver - The binding's driver.
 * @param tracing - The tracker, guard and telemetry.
 * @returns A driver that admits sends, adds the trace and records sent messages.
 */
function traceQueue(resourceId: string, driver: QueueDriver, tracing: Tracing): QueueDriver {
  return Object.freeze<QueueDriver>({
    send: async (envelope, options, given) => {
      const active = tracing.tracker.current();
      if (active !== undefined)
        await tracing.guard.admit(active, { resourceId, type: "queue.message" });
      return traced(tracing, active, `send ${resourceId}`, "producer", { "messaging.system": "holqa", "messaging.destination.name": resourceId, "messaging.operation.type": "send", "messaging.operation.name": "send" }, async (span) => {
        const context = contextOf(active, given, span);
        const receipt = await (context === undefined ? driver.send(envelope, options) : driver.send(envelope, options, context));
        span?.setAttribute("messaging.message.id", receipt.messageId);
        active?.emitted.push({ type: "queue.message", resourceId, messageId: receipt.messageId });
        return receipt;
      });
    }
  });
}

/**
 * Wraps one bucket driver. Every operation of handler code gets a client
 * span; writes and deletes are also admitted, traced and recorded.
 *
 * @param resourceId - The bucket's identifier.
 * @param driver - The binding's driver.
 * @param tracing - The tracker, guard and telemetry.
 * @returns A driver that admits writes and deletes, adds the trace to them and records them.
 */
function traceBucket(resourceId: string, driver: BucketDriver, tracing: Tracing): BucketDriver {
  /**
   * Builds a storage span's attributes. Object keys are left out: they may
   * hold personal data, and spans are exported.
   *
   * @param operation - The storage operation, for example `put`.
   * @returns The bucket and operation attributes.
   */
  const attributes = (operation: string): TelemetryAttributes => ({ "holqa.resource.id": resourceId, "holqa.storage.operation": operation });
  /**
   * Runs a read-only operation in a client span.
   *
   * @param operation - The operation's name.
   * @param work - The operation.
   * @returns What it returns.
   */
  function read<Result>(operation: string, work: () => Promise<Result>): Promise<Result> {
    return traced(tracing, tracing.tracker.current(), `${operation} ${resourceId}`, "client", attributes(operation), work);
  }
  return Object.freeze<BucketDriver>({
    put: async (key, body, options, given) => {
      const active = tracing.tracker.current();
      if (active !== undefined)
        await tracing.guard.admit(active, { resourceId, type: "object.created", key });
      return traced(tracing, active, `put ${resourceId}`, "client", attributes("put"), async (span) => {
        const context = contextOf(active, given, span);
        const metadata = await (context === undefined ? driver.put(key, body, options) : driver.put(key, body, options, context));
        span?.setAttribute("holqa.storage.object.size", body.length);
        active?.emitted.push({ type: "object.created", resourceId, key });
        return metadata;
      });
    },
    delete: async (key, given) => {
      const active = tracing.tracker.current();
      if (active !== undefined)
        await tracing.guard.admit(active, { resourceId, type: "object.deleted", key });
      return traced(tracing, active, `delete ${resourceId}`, "client", attributes("delete"), async (span) => {
        const context = contextOf(active, given, span);
        const deleted = await (context === undefined ? driver.delete(key) : driver.delete(key, context));
        if (deleted)
          active?.emitted.push({ type: "object.deleted", resourceId, key });
        return deleted;
      });
    },
    get: key => read("get", () => driver.get(key)),
    head: key => read("head", () => driver.head(key)),
    list: options => read("list", () => driver.list(options)),
    signUrl: (key, options) => read("sign", () => driver.signUrl(key, options))
  });
}