// W3C Trace Context (https://www.w3.org/TR/trace-context/), the propagation
// format OpenTelemetry uses by default. Telemetry trace context is separate
// from event lineage (`InvocationLineage`): lineage drives safety controls and
// is never sampled; trace context only correlates telemetry.

/**
 * The telemetry context of one span: which trace it belongs to, its own
 * identifier, and whether the trace is sampled (recorded and exported).
 */
export interface TraceContext {
  /** 32 lowercase hexadecimal characters, not all zero. */
  readonly traceId: string;
  /** 16 lowercase hexadecimal characters, not all zero. */
  readonly spanId: string;
  /** Whether the trace's spans are recorded. An unsampled context is still propagated, so downstream services make the same decision. */
  readonly sampled: boolean;
  /** Vendor-specific `tracestate` entries, passed through unchanged. */
  readonly traceState?: string;
}

/** The header that carries a {@link TraceContext} across HTTP and message boundaries. */
export const traceparentHeader = "traceparent";

/** The header that carries vendor-specific trace state next to `traceparent`. */
export const tracestateHeader = "tracestate";

/**
 * `version-traceId-spanId-flags`, lowercase hexadecimal only. Version 00 has
 * exactly these fields; a later version may append more after a dash, which
 * are ignored, as the specification requires. Version `ff` is invalid.
 */
const traceparentPattern = /^(?!ff)([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})(-.*)?$/;

/** Longest `tracestate` value passed through; the specification allows 32 entries of up to 256 characters each. */
const maxTraceStateLength = 512;

/**
 * Reports whether a value is a valid trace identifier: 32 lowercase
 * hexadecimal characters, not all zero.
 *
 * @param value - The candidate, typically untrusted.
 * @returns `true` when the value can identify a trace.
 */
export function isTraceId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{32}$/.test(value) && !/^0+$/.test(value);
}

/**
 * Reports whether a value is a valid span identifier: 16 lowercase
 * hexadecimal characters, not all zero.
 *
 * @param value - The candidate, typically untrusted.
 * @returns `true` when the value can identify a span.
 */
export function isSpanId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{16}$/.test(value) && !/^0+$/.test(value);
}

/**
 * Reads a `traceparent` header value without trusting it. Version `00` must
 * have exactly four fields; later versions are read by their first four
 * fields; version `ff`, an all-zero trace or span identifier, or uppercase
 * hexadecimal make the value invalid, and the caller should then start a new trace.
 *
 * @param value - The header value, typically untrusted.
 * @param traceState - The `tracestate` header value, if any; kept when it is short printable ASCII.
 * @returns The context, or `undefined` when the value is absent or malformed.
 *
 * @example
 * ```ts
 * parseTraceparent("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01");
 * // { traceId: "4bf92f3577b34da6a3ce929d0e0e4736", spanId: "00f067aa0ba902b7", sampled: true }
 * ```
 */
export function parseTraceparent(value: unknown, traceState?: unknown): TraceContext | undefined {
  if (typeof value !== "string")
    return undefined;
  const match = traceparentPattern.exec(value.trim());
  if (match === null)
    return undefined;
  const [, version, traceId, spanId, flags = "00", rest] = match;
  if (!isTraceId(traceId) || !isSpanId(spanId) || (version === "00" && rest !== undefined))
    return undefined;
  const state = typeof traceState === "string" && traceState.length > 0 && traceState.length <= maxTraceStateLength && /^[\x20-\x7E]+$/.test(traceState) ? traceState : undefined;
  return Object.freeze({ traceId, spanId, sampled: (Number.parseInt(flags, 16) & 1) === 1, ...state === undefined ? {} : { traceState: state } });
}

/**
 * Formats a context as a `traceparent` header value.
 *
 * @param context - The context to propagate.
 * @returns `00-<traceId>-<spanId>-<01|00>`.
 */
export function formatTraceparent(context: TraceContext): string {
  return `00-${context.traceId}-${context.spanId}-${context.sampled ? "01" : "00"}`;
}

/**
 * Creates a random trace identifier with the Web Crypto API.
 *
 * @returns 32 lowercase hexadecimal characters, never all zero.
 */
export function randomTraceId(): string {
  return randomHex(16);
}

/**
 * Creates a random span identifier with the Web Crypto API.
 *
 * @returns 16 lowercase hexadecimal characters, never all zero.
 */
export function randomSpanId(): string {
  return randomHex(8);
}

/**
 * Creates random non-zero bytes as lowercase hexadecimal.
 *
 * @param bytes - How many random bytes.
 * @returns The hexadecimal string.
 */
function randomHex(bytes: number): string {
  const buffer = new Uint8Array(bytes);
  for (;;) {
    crypto.getRandomValues(buffer);
    if (buffer.some(byte => byte !== 0))
      return Array.from(buffer, byte => byte.toString(16).padStart(2, "0")).join("");
  }
}