import type {
  AppDescriptor,
  Described,
  HandlerEventPolicy,
  HandlerIdempotencyPolicy,
  InvocationLogger,
  ResourceDescriptorOf,
  ResourceReference

} from "@holqa/core";

import type { DeclarationProblems } from "@/internal/declaration";

import {
  diagnosticCodes,
  eventPolicyProblems,
  failWith,
  getResourceDescriptor,
  maxIdempotencyLeaseSeconds,
  maxIdempotencyRetentionSeconds,
  requireBinding
} from "@holqa/core";

import {
  definedEntries,
  freezeJson,
  optionalObject
} from "@/internal/declaration";

/** A queue or bucket handle: the resources whose events handlers publish. */
export type PublishableResource = Described<ResourceDescriptorOf<"queue">> | Described<ResourceDescriptorOf<"bucket">>;

/**
 * Event safety settings of a handler registration. Static analysis and the
 * runtime use them; none of them changes what the handler does.
 */
export interface HandlerEventOptions {
  /**
   * Resources the handler sends to, writes to or deletes from in code that
   * static analysis cannot follow (dynamic dispatch, a library that receives
   * the handle). Listed targets count as known publications in the event graph.
   */
  readonly publishes?: readonly PublishableResource[];
  /**
   * Declares that the handler takes part in an intentional event cycle, for
   * example requeueing work until it reaches a terminal state, and explains
   * why it terminates. Cycles through the handler are then reported as
   * allowed instead of warned about. Runtime limits still apply.
   */
  readonly cycle?: { readonly justification: string };
  /** The most events one invocation may publish. Overrides the runtime's default (1000). */
  readonly maxPublications?: number;
  /** The deepest event this handler receives. Overrides the runtime's default (16). */
  readonly maxDepth?: number;
}

/**
 * Duplicate suppression for a queue consumer or object event handler. The
 * runtime binding must provide an idempotency store.
 *
 * Before the handler runs, its key is claimed; a delivery whose key already
 * completed is acknowledged without running the handler, and one whose key
 * another delivery holds is retried later. A failed handler releases its key.
 * This suppresses duplicate *deliveries*; it does not make side effects
 * exactly-once: a handler that fails after a side effect (or crashes before
 * its key is recorded) runs again.
 *
 * @typeParam Context - What the key function receives: the validated message or object and the delivery.
 */
export interface IdempotencyOptions<Context> {
  /**
   * Derives the key from the validated input, for example a business
   * identifier that catches duplicates sent as separate messages. Default:
   * the message identifier, or the object event identifier.
   */
  readonly key?: (context: Context) => string;
  /** How long completed keys are remembered, in seconds, at most one year. Default 86 400 (one day). */
  readonly retentionSeconds?: number;
  /**
   * How long a claim lasts without renewal, in seconds. The claim is renewed
   * every half lease while the handler runs, so this only bounds how long a
   * crashed attempt blocks its key; keep it shorter than the time until the
   * message is redelivered. At most 86 400. Default 30.
   */
  readonly leaseSeconds?: number;
}

/** A validated idempotency setting: the JSON policy and the optional key function. */
export interface ReadIdempotency<Context> {
  readonly policy: HandlerIdempotencyPolicy;
  readonly key?: (context: Context) => string;
}

/** Default retention of completed keys, in seconds. */
const defaultRetentionSeconds = 86_400;

/** Default claim lease, in seconds: shorter than the runtime's default redelivery after a lost lease (35 s). */
const defaultLeaseSeconds = 30;

/** The longest idempotency key, in characters. */
const maxKeyLength = 512;

/**
 * Validates a registration's `events` option and converts it into the JSON
 * policy stored in the handler definition. Publication targets are recorded
 * by kind and identifier, sorted and without duplicates.
 *
 * @param value - The untrusted option.
 * @param problems - Where to record problems.
 * @returns The policy, or `undefined` when the option is absent.
 */
export function readEventOptions(value: unknown, problems: DeclarationProblems): HandlerEventPolicy | undefined {
  if (value === undefined)
    return undefined;
  const raw = optionalObject<HandlerEventOptions>(value, "events", problems);
  let publishes: ResourceReference[] | undefined;
  if (raw.publishes !== undefined) {
    if (!Array.isArray(raw.publishes)) {
      problems.invalid("\"events.publishes\" must be a list of resource handles.");
    } else {
      const references = new Map<string, ResourceReference>();
      for (const entry of raw.publishes as readonly unknown[]) {
        const descriptor = getResourceDescriptor(entry);
        if (descriptor === undefined || (descriptor.kind !== "queue" && descriptor.kind !== "bucket"))
          problems.invalid("\"events.publishes\" must list queue and bucket handles, such as resources.orders.");
        else
          references.set(`${descriptor.kind}:${descriptor.id}`, { kind: descriptor.kind, id: descriptor.id });
      }
      publishes = [...references.entries()].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([, reference]) => reference);
    }
  }
  const cycle = raw.cycle === undefined ? undefined : optionalObject<{ readonly justification: string }>(raw.cycle, "events.cycle", problems);
  const policy = definedEntries({
    publishes,
    cycle: cycle === undefined ? undefined : { justification: typeof cycle.justification === "string" ? cycle.justification.trim() : cycle.justification },
    maxPublications: raw.maxPublications,
    maxDepth: raw.maxDepth
  });
  for (const key of Object.keys(value as object)) {
    if (!["publishes", "cycle", "maxPublications", "maxDepth"].includes(key))
      problems.invalid(`"events" has the unknown setting "${key}".`);
  }
  // The shared checker validates what the compiler and runtime will read; the
  // SDK only reports what it has not reported already.
  for (const problem of eventPolicyProblems({ ...policy, publishes: undefined }).filter(problem => !problem.startsWith("\"events\" has the unknown")))
    problems.invalid(problem);
  return freezeJson(policy) as HandlerEventPolicy;
}

/**
 * Validates a registration's `idempotency` option.
 *
 * @param value - The untrusted option: `true` or an options object.
 * @param problems - Where to record problems.
 * @returns The policy and key function, or `undefined` when the option is absent or `false`.
 */
export function readIdempotencyOptions<Context>(value: unknown, problems: DeclarationProblems): ReadIdempotency<Context> | undefined {
  if (value === undefined || value === false)
    return undefined;
  const raw = value === true ? {} : optionalObject<IdempotencyOptions<Context>>(value, "idempotency", problems);
  if (raw.key !== undefined && typeof raw.key !== "function")
    problems.invalid("\"idempotency.key\" must be a function that returns the key.");
  for (const [name, value, maximum] of [["retentionSeconds", raw.retentionSeconds, maxIdempotencyRetentionSeconds], ["leaseSeconds", raw.leaseSeconds, maxIdempotencyLeaseSeconds]] as const) {
    if (value !== undefined && !(typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= maximum))
      problems.invalid(`"idempotency.${name}" must be a whole number of seconds from 1 to ${maximum}.`);
  }
  const policy: HandlerIdempotencyPolicy = freezeJson({
    key: typeof raw.key === "function" ? "custom" as const : "delivery" as const,
    retentionSeconds: typeof raw.retentionSeconds === "number" ? raw.retentionSeconds : defaultRetentionSeconds,
    leaseSeconds: typeof raw.leaseSeconds === "number" ? raw.leaseSeconds : defaultLeaseSeconds
  });
  return typeof raw.key === "function" ? { policy, key: raw.key as (context: Context) => string } : { policy };
}

/** What {@link runIdempotently} needs to know about one delivery. */
export interface IdempotentRun {
  readonly app: AppDescriptor;
  readonly handlerId: string;
  readonly policy: HandlerIdempotencyPolicy;
  /** The delivery's key, from the key function or the delivery identifier. */
  readonly key: unknown;
  readonly log: InvocationLogger;
}

/**
 * Runs a handler at most once per idempotency key among deliveries that the
 * store sees: claims the key, skips the handler when the key already
 * completed, and records completion after the handler succeeded.
 *
 * @param run - The application, handler, policy, key and logger.
 * @param handler - Calls the user's handler.
 * @returns A promise that settles once the handler ran or was skipped.
 * @throws {HolqaError} `HOLQA_BINDING_CAPABILITY_UNSUPPORTED` when the binding has no idempotency store,
 * `HOLQA_OPERATION_INVALID` for a key that is not a non-empty string of at most 512 characters,
 * `HOLQA_IDEMPOTENCY_IN_PROGRESS` while another delivery holds the key; and whatever the handler throws.
 */
export async function runIdempotently(run: IdempotentRun, handler: () => Promise<void> | void): Promise<void> {
  const operation = `idempotency of handler "${run.handlerId}"`;
  const binding = requireBinding(run.app, operation);
  const store = binding.idempotency;
  if (store === undefined)
    failWith(diagnosticCodes.bindingCapabilityUnsupported, `Binding "${binding.name}" provides no idempotency store, which the handler "${run.handlerId}" declares.`, "Use a binding with an idempotency store, such as the local binding from @holqa/local, or remove the handler's idempotency option.");
  const { key } = run;
  if (typeof key !== "string" || key === "" || key.length > maxKeyLength)
    failWith(diagnosticCodes.operationInvalid, `The idempotency key of handler "${run.handlerId}" must be a non-empty string of at most ${maxKeyLength} characters.`);
  const claim = await store.begin(run.handlerId, key, { leaseMs: run.policy.leaseSeconds * 1000 });
  if (claim.status === "completed") {
    run.log.info("duplicate delivery skipped; its idempotency key already completed", { idempotencyKey: key, completedAt: claim.completedAt });
    return;
  }
  if (claim.status === "in-progress")
    failWith(diagnosticCodes.idempotencyInProgress, `Another delivery of handler "${run.handlerId}" holds the idempotency key until ${claim.expiresAt}; this delivery is retried.`);
  const leaseMs = run.policy.leaseSeconds * 1000;
  // Renew the claim while the handler runs, so only a crashed attempt loses it.
  const renewal = setInterval(() => {
    store.extend(run.handlerId, key, claim.token, { leaseMs }).then((held) => {
      if (!held)
        run.log.warn("the idempotency claim was lost while the handler was running; a duplicate may run concurrently", { idempotencyKey: key });
    }, (error: unknown) => {
      run.log.warn("renewing an idempotency claim failed", { idempotencyKey: key, error: error instanceof Error ? error.message : String(error) });
    });
  }, Math.max(500, Math.floor(leaseMs / 2)));
  try {
    await handler();
  } catch (error) {
    clearInterval(renewal);
    await store.release(run.handlerId, key, claim.token).catch((releaseError: unknown) => {
      run.log.warn("releasing an idempotency key failed; it stays blocked until its lease ends", { idempotencyKey: key, error: releaseError instanceof Error ? releaseError.message : String(releaseError) });
    });
    throw error;
  } finally {
    clearInterval(renewal);
  }
  if (!await store.complete(run.handlerId, key, claim.token, { retentionMs: run.policy.retentionSeconds * 1000 }))
    run.log.warn("the idempotency claim ended before the handler finished; a duplicate may run again", { idempotencyKey: key });
}