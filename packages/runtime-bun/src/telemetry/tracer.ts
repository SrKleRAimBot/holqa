import type {
  Redactor,
  SpanEvent,
  SpanKind,
  SpanLink,
  SpanRecord,
  SpanStatus,
  TelemetryAttributes,
  TelemetryAttributeValue,
  TraceContext
} from "@holqa/core";

import { formatTraceparent } from "@holqa/core";

/** Creates trace and span identifiers; injectable for deterministic tests. */
export interface TelemetryIdGenerator {
  /** Returns 32 lowercase hexadecimal characters, not all zero. */
  readonly traceId: () => string;
  /** Returns 16 lowercase hexadecimal characters, not all zero. */
  readonly spanId: () => string;
}

/** What a new span starts with. */
export interface SpanStart {
  readonly name: string;
  readonly kind: SpanKind;
  /** The parent context: the span joins its trace and inherits its sampling decision. Absent starts a new trace. */
  readonly parent?: TraceContext;
  readonly links?: readonly SpanLink[];
  readonly attributes?: TelemetryAttributes;
}

/** Settings of a {@link Tracer}. */
export interface TracerOptions {
  /** The share of new traces that are sampled, from 0 to 1. Traces with a parent follow the parent's decision. */
  readonly sampleRatio: number;
  readonly ids: TelemetryIdGenerator;
  /** The wall clock in epoch milliseconds, for span start times. */
  readonly wallNow: () => number;
  /** A monotonic clock in milliseconds, for span durations. */
  readonly monotonicNow: () => number;
  /** Applied to attributes and events when a span ends. */
  readonly redactor: Redactor;
  /** Receives every sampled span once it ends. */
  readonly onEnd: (span: SpanRecord) => void;
}

/** The most attributes and events one span keeps; more are dropped, as OpenTelemetry's default limits do. */
const maxAttributes = 128;
const maxEvents = 128;

/**
 * A span in progress. Methods on an unsampled or ended span are cheap no-ops,
 * except that its context is still available for propagation.
 */
export class ActiveSpan {
  /** The span's context, propagated to children and across boundaries. */
  readonly context: TraceContext;
  /** The parent span, when the span has one. */
  readonly parentSpanId: string | undefined;
  /** The span's role: server, client, producer, consumer or internal. */
  readonly kind: SpanKind;
  /** The span's name; may be refined until it ends. */
  private name: string;
  /** Epoch milliseconds. */
  private readonly startTime: number;
  /** Monotonic milliseconds at start. */
  private readonly startMonotonic: number;
  /** Attributes so far. */
  private readonly attributes: Record<string, TelemetryAttributeValue> = {};
  /** Events so far. */
  private readonly events: SpanEvent[] = [];
  /** Links given at start. */
  private readonly links: readonly SpanLink[];
  /** The status so far. */
  private status: SpanStatus = { code: "unset" };
  /** Whether {@link end} was called. */
  private ended = false;
  /** The tracer's settings. */
  private readonly options: TracerOptions;

  /**
   * Creates a span; use {@link Tracer.startSpan}.
   *
   * @param options - The tracer's settings.
   * @param start - The span's name, kind, parent, links and attributes.
   * @param context - The span's own context.
   */
  constructor(options: TracerOptions, start: SpanStart, context: TraceContext) {
    this.options = options;
    this.context = context;
    this.parentSpanId = start.parent?.spanId;
    this.kind = start.kind;
    this.name = start.name;
    this.links = start.links ?? [];
    this.startTime = options.wallNow();
    this.startMonotonic = options.monotonicNow();
    if (start.attributes !== undefined)
      this.setAttributes(start.attributes);
  }

  /**
   * The span's context as a W3C `traceparent` value.
   *
   * @returns The header value.
   */
  get traceparent(): string {
    return formatTraceparent(this.context);
  }

  /**
   * Reports whether the span is recorded.
   *
   * @returns `true` when the span will be exported once it ends.
   */
  get recording(): boolean {
    return this.context.sampled && !this.ended;
  }

  /**
   * Sets one attribute, replacing an earlier value.
   *
   * @param key - The attribute key, preferably from OpenTelemetry semantic conventions.
   * @param value - A scalar or homogeneous array.
   */
  setAttribute(key: string, value: TelemetryAttributeValue): void {
    if (!this.recording)
      return;
    if (key in this.attributes || Object.keys(this.attributes).length < maxAttributes)
      this.attributes[key] = value;
  }

  /**
   * Sets several attributes.
   *
   * @param attributes - The attributes to set.
   */
  setAttributes(attributes: TelemetryAttributes): void {
    for (const [key, value] of Object.entries(attributes))
      this.setAttribute(key, value);
  }

  /**
   * Records something that happened during the span.
   *
   * @param name - The event's name, for example `exception`.
   * @param attributes - Details of what happened.
   */
  addEvent(name: string, attributes?: TelemetryAttributes): void {
    if (this.recording && this.events.length < maxEvents)
      this.events.push({ name, time: this.now(), ...attributes === undefined ? {} : { attributes } });
  }

  /**
   * Records a caught error as an `exception` event, following OpenTelemetry's
   * exception conventions. Its message and stack are redacted when the span ends.
   *
   * @param error - The caught value.
   */
  recordException(error: unknown): void {
    if (!this.recording)
      return;
    const attributes: Record<string, string> = error instanceof Error
      ? { "exception.type": error.name, "exception.message": error.message, ...error.stack === undefined ? {} : { "exception.stacktrace": error.stack } }
      : { "exception.message": String(error) };
    this.addEvent("exception", attributes);
  }

  /**
   * Sets the span's status.
   *
   * @param status - Whether the operation succeeded.
   */
  setStatus(status: SpanStatus): void {
    if (this.recording)
      this.status = status;
  }

  /**
   * Refines the span's name, for example once a route is matched.
   *
   * @param name - The new name.
   */
  updateName(name: string): void {
    if (this.recording)
      this.name = name;
  }

  /** Ends the span and hands it to the export pipeline when it is sampled. Calling it again has no effect. */
  end(): void {
    if (this.ended)
      return;
    const sampled = this.context.sampled;
    this.ended = true;
    if (!sampled)
      return;
    const { redactor } = this.options;
    this.options.onEnd(Object.freeze({
      traceId: this.context.traceId,
      spanId: this.context.spanId,
      ...this.parentSpanId === undefined ? {} : { parentSpanId: this.parentSpanId },
      name: this.name,
      kind: this.kind,
      startTime: this.startTime,
      endTime: this.now(),
      status: this.status.code === "error" && this.status.message !== undefined ? { code: "error" as const, message: redactor.text(this.status.message) } : this.status,
      attributes: redactor.attributes(this.attributes),
      events: this.events.map(event => event.attributes === undefined ? event : { ...event, attributes: redactor.attributes(event.attributes) }),
      links: this.links
    }));
  }

  /**
   * Returns the current time on the span's timeline: its start time plus
   * the monotonic time elapsed since, so durations never go negative.
   *
   * @returns Epoch milliseconds.
   */
  private now(): number {
    return this.startTime + Math.max(0, this.options.monotonicNow() - this.startMonotonic);
  }
}

/**
 * Starts spans with parent-based sampling: a span with a parent follows the
 * parent's decision, and a new trace is sampled when the low 56 bits of its
 * trace identifier, read as a number, are below `ratio * 2^56`. The decision
 * depends only on the trace identifier, so Holqa runtimes sampling at the
 * same ratio agree; other implementations may compute it differently, which
 * parent-based propagation makes irrelevant within one trace.
 */
export class Tracer {
  /** Settings. */
  private readonly options: TracerOptions;

  /**
   * Creates a tracer.
   *
   * @param options - Sampling, identifiers, clocks, redaction and the export callback.
   */
  constructor(options: TracerOptions) {
    this.options = options;
  }

  /**
   * Starts a span.
   *
   * @param start - Its name, kind, parent, links and attributes.
   * @returns The span; end it with {@link ActiveSpan.end}.
   */
  startSpan(start: SpanStart): ActiveSpan {
    const traceId = start.parent?.traceId ?? this.options.ids.traceId();
    const sampled = start.parent?.sampled ?? this.sample(traceId);
    const traceState = start.parent?.traceState;
    return new ActiveSpan(this.options, start, Object.freeze({ traceId, spanId: this.options.ids.spanId(), sampled, ...traceState === undefined ? {} : { traceState } }));
  }

  /**
   * Decides whether a new trace is sampled.
   *
   * @param traceId - The new trace's identifier.
   * @returns `true` when the trace is recorded.
   */
  private sample(traceId: string): boolean {
    const { sampleRatio } = this.options;
    if (sampleRatio >= 1)
      return true;
    if (sampleRatio <= 0)
      return false;
    return Number.parseInt(traceId.slice(18), 16) < sampleRatio * 2 ** 56;
  }
}