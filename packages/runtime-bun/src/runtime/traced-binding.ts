import type {
  BucketDriver,
  DriverOperationContext,
  QueueDriver,
  ResourceDescriptorOf,
  RuntimeBinding
} from "@holqa/core";

import type { InvocationTracker } from "@/dispatch/invocation-tracker";

/**
 * Wraps a binding's queue and bucket drivers so that every send, write and
 * delete performed by handler code carries the running invocation's trace
 * (`correlationId` and, as `causationId`, its `invocationId`) and is recorded
 * as something the invocation emitted. Operations outside an invocation pass
 * through unchanged. Capabilities, sources and configuration are not touched.
 *
 * @param binding - The binding the runtime installs.
 * @param tracker - Knows which invocation is running.
 * @returns A binding with traced drivers.
 */
export function traceBinding(binding: RuntimeBinding, tracker: InvocationTracker): RuntimeBinding {
  const { queue, bucket } = binding.drivers;
  return Object.freeze({
    ...binding,
    drivers: Object.freeze({
      ...binding.drivers,
      ...queue === undefined ? {} : { queue: (resource: ResourceDescriptorOf<"queue">) => traceQueue(resource.id, queue(resource), tracker) },
      ...bucket === undefined ? {} : { bucket: (resource: ResourceDescriptorOf<"bucket">) => traceBucket(resource.id, bucket(resource), tracker) }
    })
  });
}

/**
 * Builds the driver context of an operation from the running invocation.
 *
 * @param tracker - Knows which invocation is running.
 * @param given - A context the caller already passed; it wins.
 * @returns The context, or `undefined` outside an invocation.
 */
function contextOf(tracker: InvocationTracker, given: DriverOperationContext | undefined): DriverOperationContext | undefined {
  if (given !== undefined)
    return given;
  const active = tracker.current();
  return active === undefined ? undefined : { trace: { correlationId: active.correlationId, causationId: active.invocationId } };
}

/**
 * Wraps one queue driver.
 *
 * @param resourceId - The queue's identifier.
 * @param driver - The binding's driver.
 * @param tracker - Knows which invocation is running.
 * @returns A driver that adds the trace and records sent messages.
 */
function traceQueue(resourceId: string, driver: QueueDriver, tracker: InvocationTracker): QueueDriver {
  return Object.freeze<QueueDriver>({
    send: async (envelope, options, given) => {
      const active = tracker.current();
      const context = contextOf(tracker, given);
      const receipt = await (context === undefined ? driver.send(envelope, options) : driver.send(envelope, options, context));
      active?.emitted.push({ type: "queue.message", resourceId, messageId: receipt.messageId });
      return receipt;
    }
  });
}

/**
 * Wraps one bucket driver. Reads and listings pass through.
 *
 * @param resourceId - The bucket's identifier.
 * @param driver - The binding's driver.
 * @param tracker - Knows which invocation is running.
 * @returns A driver that adds the trace to writes and deletes and records them.
 */
function traceBucket(resourceId: string, driver: BucketDriver, tracker: InvocationTracker): BucketDriver {
  return Object.freeze<BucketDriver>({
    put: async (key, body, options, given) => {
      const active = tracker.current();
      const context = contextOf(tracker, given);
      const metadata = await (context === undefined ? driver.put(key, body, options) : driver.put(key, body, options, context));
      active?.emitted.push({ type: "object.created", resourceId, key });
      return metadata;
    },
    delete: async (key, given) => {
      const active = tracker.current();
      const context = contextOf(tracker, given);
      const deleted = await (context === undefined ? driver.delete(key) : driver.delete(key, context));
      if (deleted)
        active?.emitted.push({ type: "object.deleted", resourceId, key });
      return deleted;
    },
    get: key => driver.get(key),
    head: key => driver.head(key),
    list: options => driver.list(options),
    signUrl: (key, options) => driver.signUrl(key, options)
  });
}