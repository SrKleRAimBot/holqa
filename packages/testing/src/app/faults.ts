import type {
  HandlerDescriptor,
  InvocationContext
} from "@holqa/core";

import {
  descriptorKey,
  getHandlerDescriptor
} from "@holqa/core";

/** Settings of one injected failure. */
export interface FailureOptions {
  /** How many matching invocations fail. Default 1. */
  readonly times?: number;
  /** The error thrown; a function is called once per failure. Default an `Error` naming the handler. */
  readonly error?: Error | (() => Error);
  /** Only invocations for which this returns `true` fail and count; default every invocation. */
  readonly when?: (input: unknown, context: InvocationContext<object>) => boolean;
}

/** An injected failure that has not been used up. */
interface PendingFailure {
  remaining: number;
  readonly options: FailureOptions;
}

/**
 * Injected handler failures, by handler identifier. A failure is thrown
 * before the handler's own code runs, so it behaves like a handler that
 * threw: the runtime reports `HOLQA_HANDLER_FAILED` and background triggers
 * apply their retry policy.
 */
export class FaultPlan {
  /** Pending failures by handler identifier, in the order they were added. */
  private readonly pending = new Map<string, PendingFailure[]>();

  /**
   * Makes the next matching invocations of a handler fail.
   *
   * @param handlerId - The handler's identifier.
   * @param options - How often, with which error, and for which invocations.
   * @throws {RangeError} When `times` is not a positive integer.
   */
  add(handlerId: string, options: FailureOptions = {}): void {
    const times = options.times ?? 1;
    if (!Number.isSafeInteger(times) || times < 1)
      throw new RangeError(`"times" must be a positive integer, not ${String(times)}.`);
    const list = this.pending.get(handlerId) ?? [];
    list.push({ remaining: times, options });
    this.pending.set(handlerId, list);
  }

  /**
   * Removes every pending failure.
   */
  clear(): void {
    this.pending.clear();
  }

  /**
   * Returns how many injected failures of a handler are still pending.
   *
   * @param handlerId - The handler's identifier.
   * @returns The remaining failures.
   */
  remaining(handlerId: string): number {
    return (this.pending.get(handlerId) ?? []).reduce((total, failure) => total + failure.remaining, 0);
  }

  /**
   * Wraps a handler registration so that its invocations consult the plan.
   * Values that are not handler registrations are returned unchanged, so the
   * runtime still reports them.
   *
   * @param registration - A handler module's export.
   * @returns A registration whose `invoke` may throw an injected failure first.
   */
  instrument(registration: unknown): unknown {
    const descriptor = getHandlerDescriptor(registration);
    if (descriptor === undefined)
      return registration;
    const handlerId = descriptor.definition.id;
    const original = descriptor.invoke as (input: unknown, context: InvocationContext<object>) => Promise<unknown>;
    /**
     * Throws a pending injected failure, or runs the handler.
     *
     * @param input - The invocation's input.
     * @param context - The invocation's context.
     * @returns What the handler returns.
     */
    const invoke = async (input: unknown, context: InvocationContext<object>): Promise<unknown> => {
      const failure = this.take(handlerId, input, context);
      if (failure !== undefined)
        throw failure;
      return original(input, context);
    };
    return Object.freeze({ [descriptorKey]: Object.freeze({ ...descriptor, invoke } as HandlerDescriptor) });
  }

  /**
   * Uses up one pending failure that matches an invocation.
   *
   * @param handlerId - The handler being invoked.
   * @param input - The invocation's input.
   * @param context - The invocation's context.
   * @returns The error to throw, or `undefined` when the invocation runs normally.
   */
  private take(handlerId: string, input: unknown, context: InvocationContext<object>): Error | undefined {
    const list = this.pending.get(handlerId);
    const match = list?.find(failure => failure.remaining > 0 && (failure.options.when === undefined || failure.options.when(input, context)));
    if (match === undefined)
      return undefined;
    match.remaining -= 1;
    const { error } = match.options;
    return error === undefined ? new Error(`Injected failure of handler "${handlerId}".`) : typeof error === "function" ? error() : error;
  }
}