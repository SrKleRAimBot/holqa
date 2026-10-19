import type { HandlerDefinition } from "@holqa/core";

import {
  diagnosticCodes,
  failWith,
  getAppDescriptor
} from "@holqa/core";

/** Settings of {@link manualTriggerMetadata}. */
export interface ManualTriggerOptions {
  /** The current time in epoch milliseconds, used for event and scheduled times. */
  readonly now: number;
  /** Creates message, event and run identifiers that are not given. */
  readonly createId: () => string;
  /** The delivery attempt a queue consumer or object event handler sees. Default 1. */
  readonly attempt?: number;
  /** The message identifier a queue consumer sees. Default: a new identifier. */
  readonly messageId?: string;
  /** The event identifier an object event handler sees. Default: a new identifier. */
  readonly eventId?: string;
}

/**
 * Builds the trusted metadata a runtime requires to invoke a background
 * handler directly (`runtime.invoke`), as if its trigger had fired once: a
 * first delivery of a new message for queue consumers (with the queue's
 * schema version), a first delivery of a new event for object event handlers,
 * and a manual run at `now` for schedule handlers. Used by `holqa invoke` and
 * by test helpers; nothing is stored, so the invocation does not appear in
 * queue, event or schedule history.
 *
 * @example
 * ```ts
 * const metadata = manualTriggerMetadata(app, definition, { now: Date.now(), createId: () => crypto.randomUUID() });
 * const outcome = await runtime.invoke({ handlerId: definition.id, input: { orderId: "123" }, metadata });
 * ```
 *
 * @param app - The application that declares the handler's resource.
 * @param definition - The handler's definition, for example from `runtime.handlers`.
 * @param options - The time, identifiers and attempt.
 * @returns The metadata for `InvocationRequest.metadata`.
 * @throws {HolqaError} `HOLQA_OPERATION_INVALID` for HTTP routes and procedures, which are invoked with an HTTP request, and for an attempt that is not a positive integer; `HOLQA_APP_INVALID` for a value that is not an application.
 */
export function manualTriggerMetadata(app: unknown, definition: HandlerDefinition, options: ManualTriggerOptions): object {
  const descriptor = getAppDescriptor(app);
  if (descriptor === undefined)
    failWith(diagnosticCodes.appInvalid, "Manual trigger metadata needs a Holqa application.");
  const attempt = options.attempt ?? 1;
  if (!Number.isSafeInteger(attempt) || attempt < 1)
    failWith(diagnosticCodes.operationInvalid, `The attempt of a manual invocation must be a positive integer, not ${String(attempt)}.`);
  const time = new Date(options.now).toISOString();
  const { trigger } = definition;
  switch (trigger.kind) {
    case "queue.message": {
      const queue = descriptor.resources.find(resource => resource.kind === "queue" && resource.id === trigger.resource.id);
      const schemaVersion = queue?.kind === "queue" ? queue.config.schemaVersion : undefined;
      return { attempt, messageId: options.messageId ?? options.createId(), ...schemaVersion === undefined ? {} : { schemaVersion } };
    }
    case "bucket.object-created":
    case "bucket.object-deleted":
      return { eventId: options.eventId ?? options.createId(), eventTime: time, attempt };
    case "schedule.tick":
      return { scheduledTime: time, runId: options.createId(), trigger: "manual" };
    case "http.route":
    case "http.procedure":
      return failWith(diagnosticCodes.operationInvalid, `The handler "${definition.id}" serves HTTP; send it a request instead of invoking it directly.`, "Call the route or procedure over HTTP, for example with curl or runtime.fetch.");
  }
}