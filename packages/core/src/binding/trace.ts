/**
 * Where a delivery came from, for tracing a chain of invocations: the
 * correlation identifier of the invocation that sent the message or wrote the
 * object, and that invocation's identifier. A runtime passes it to drivers
 * when handler code sends or writes, and a binding that can store it returns
 * it with every delivery, so the receiving invocation joins the same trace.
 * Bindings that cannot store it omit it; delivery is unaffected.
 */
export interface DeliveryTrace {
  /** Groups every invocation of one causal chain, for example everything one HTTP request caused. */
  readonly correlationId: string;
  /** The invocation that sent the message or wrote the object. Absent when it was not sent by an invocation. */
  readonly causationId?: string;
}