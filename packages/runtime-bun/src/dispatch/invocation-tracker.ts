import { AsyncLocalStorage } from "node:async_hooks";

/** A queue message an invocation sent. */
export interface EmittedQueueMessage {
  readonly type: "queue.message";
  /** The queue's logical identifier. */
  readonly resourceId: string;
  /** The identifier the queue assigned; every delivery of the message carries it. */
  readonly messageId: string;
}

/** An object an invocation wrote or deleted, which the bucket reports as an object event. */
export interface EmittedObjectChange {
  readonly type: "object.created" | "object.deleted";
  /** The bucket's logical identifier. */
  readonly resourceId: string;
  readonly key: string;
}

/**
 * Something an invocation caused through a resource handle: a sent message or
 * a changed object. Recorded once the driver accepted the operation, so a
 * failed send is not listed.
 */
export type EmittedEvent = EmittedQueueMessage | EmittedObjectChange;

/** The invocation whose handler code is running in the current asynchronous context. */
export interface ActiveInvocation {
  readonly invocationId: string;
  readonly correlationId: string;
  readonly handlerId: string;
  /** What the invocation has emitted so far, in order. */
  readonly emitted: EmittedEvent[];
}

/**
 * Tracks which invocation is running in each asynchronous context, so that
 * resource operations (which handlers perform through application-wide
 * handles) can be attributed to the invocation that performed them. One
 * tracker belongs to one runtime.
 *
 * Bun-specific note: relies on `AsyncLocalStorage` from `node:async_hooks`,
 * which Bun 1.3 implements, including propagation through timers and promises.
 */
export class InvocationTracker {
  /** The context storage. */
  private readonly storage = new AsyncLocalStorage<ActiveInvocation>();

  /**
   * Runs a function as part of an invocation: resource operations it performs,
   * also asynchronously, are attributed to that invocation.
   *
   * @param invocation - The invocation the work belongs to.
   * @param work - The handler call.
   * @returns What `work` returns.
   */
  run<Result>(invocation: ActiveInvocation, work: () => Result): Result {
    return this.storage.run(invocation, work);
  }

  /**
   * Returns the invocation running in the current asynchronous context.
   *
   * @returns The invocation, or `undefined` outside handler code.
   */
  current(): ActiveInvocation | undefined {
    return this.storage.getStore();
  }
}