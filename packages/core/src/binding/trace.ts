/**
 * Where a delivery came from, for tracing a chain of invocations: the
 * correlation identifier of the invocation that sent the message or wrote the
 * object, that invocation's identifier, and the event lineage (the root
 * operation and how many event hops separate the delivery from it). A runtime
 * passes it to drivers when handler code sends or writes, and a binding that
 * can store it returns it with every delivery, so the receiving invocation
 * joins the same trace and lineage. Bindings that cannot store it omit it;
 * delivery is unaffected, but the receiving invocation then starts a new
 * lineage, so depth limits and operation budgets restart for it.
 */
export interface DeliveryTrace {
  /** Groups every invocation of one causal chain, for example everything one HTTP request caused. May come from a caller. */
  readonly correlationId: string;
  /** The invocation that sent the message or wrote the object. Absent when it was not sent by an invocation. */
  readonly causationId?: string;
  /**
   * The root operation: the identifier of the invocation that started the
   * causal chain. Always assigned by a runtime, never taken from a caller, so
   * two independent operations never share it. Execution budgets are counted
   * per root operation. Absent in traces written before lineage existed.
   */
  readonly rootId?: string;
  /**
   * How many event hops separate the delivery from its root operation: 1 for
   * an event the root invocation emitted, 2 for an event emitted by the
   * invocation that handled it, and so on. A redelivery or retry keeps its
   * depth; only newly published events are one deeper. Absent in traces
   * written before lineage existed.
   */
  readonly depth?: number;
}

/**
 * The event lineage of one invocation: which business operation it belongs
 * to (correlation), what caused it (causation), the root operation it
 * descends from, and its distance from that root (depth). Separate from any
 * telemetry trace context.
 */
export interface InvocationLineage {
  /** Groups every invocation of one business operation. May come from a trusted caller, for example an `x-correlation-id` header. */
  readonly correlationId: string;
  /** The invocation whose published event caused this one. Absent for a root invocation. */
  readonly causationId?: string;
  /** The identifier of the root invocation; equal to this invocation's own identifier for a root. Assigned by the runtime only. */
  readonly rootId: string;
  /** 0 for a root invocation (an HTTP request, a scheduled run, a direct invocation); the delivered event's depth otherwise. */
  readonly depth: number;
}

/**
 * Reads the lineage a delivery carries, without trusting the binding that
 * stored it: a malformed or absent depth or root makes the delivery the start
 * of a new lineage rooted at `fallbackRootId`, at depth 0. Depth limits and
 * operation budgets therefore only span hops through bindings that store
 * `rootId` and `depth`.
 *
 * @param trace - The trace a binding returned with the delivery, if any.
 * @param fallbackRootId - The root to use when the trace carries none, for example the message identifier, so retries of an untraced message share one root.
 * @returns The lineage the receiving invocation runs with.
 *
 * @example
 * ```ts
 * lineageOfDelivery({ correlationId: "c-1", causationId: "inv-1", rootId: "inv-1", depth: 1 }, "msg-7");
 * // { correlationId: "c-1", causationId: "inv-1", rootId: "inv-1", depth: 1 }
 * ```
 */
export function lineageOfDelivery(trace: DeliveryTrace | undefined, fallbackRootId: string): InvocationLineage {
  if (trace === undefined || typeof trace.correlationId !== "string" || trace.correlationId === "")
    return Object.freeze({ correlationId: fallbackRootId, rootId: fallbackRootId, depth: 0 });
  const { correlationId, causationId, rootId, depth } = trace;
  const known = typeof rootId === "string" && rootId !== "" && typeof depth === "number" && Number.isSafeInteger(depth) && depth >= 0;
  return Object.freeze({
    correlationId,
    ...typeof causationId === "string" ? { causationId } : {},
    // A trace without lineage (written before lineage existed, or by a binding
    // that does not store it) roots at the delivery itself, never at the
    // correlation, which a caller may choose.
    rootId: known ? rootId : fallbackRootId,
    depth: known ? depth : 0
  });
}

/**
 * Builds the trace of an event an invocation publishes: the same correlation
 * and root, the invocation as its cause, and one more hop of depth.
 *
 * @param lineage - The publishing invocation's lineage.
 * @param invocationId - The publishing invocation's identifier.
 * @returns The trace to store with the published message or object event.
 */
export function childTrace(lineage: InvocationLineage, invocationId: string): DeliveryTrace {
  return Object.freeze({ correlationId: lineage.correlationId, causationId: invocationId, rootId: lineage.rootId, depth: lineage.depth + 1 });
}