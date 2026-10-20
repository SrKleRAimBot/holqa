import type {
  BindingCapabilities,
  Diagnostic,
  RuntimeBinding
} from "@holqa/core";
import type { EnvironmentVariables } from "@holqa/runtime-bun";

import type { Clock } from "@/clock";
import type { LocalQueues } from "@/queue/local-queue";
import type { LocalScheduler } from "@/schedule/local-scheduler";
import type { LocalStorage } from "@/storage/local-storage";
import { join } from "node:path";

import {
  createDiagnostic,
  diagnosticCodes,
  getAppDescriptor,
  HolqaError
} from "@holqa/core";
import { createEnvironmentBinding } from "@holqa/runtime-bun";

import { systemClock } from "@/clock";
import { createLocalQueues } from "@/queue/local-queue";
import { createLocalScheduler } from "@/schedule/local-scheduler";
import { openStateDatabase } from "@/state/database";
import { LeaseStore } from "@/state/lease-store";
import {
  createLocalIdempotencyStore,
  createLocalOperationBudgets
} from "@/state/safety-stores";
import { createLocalStorage } from "@/storage/local-storage";

/** Settings of {@link createLocalEnvironment}. */
export interface LocalEnvironmentOptions {
  /** The application: the default export of its `infra.ts`. */
  readonly app: unknown;
  /**
   * Where queue, event, object and schedule state is kept: a `state.sqlite`
   * database and an `objects/` directory. Created when missing; reusing it
   * keeps state across restarts.
   */
  readonly directory: string;
  /** Configuration values, validated like the runtime's default binding. Defaults to `process.env`. */
  readonly env?: EnvironmentVariables;
  /** The time source for delays, leases, signed URL expiry and schedules. Defaults to the wall clock. */
  readonly clock?: Clock;
  /** Creates message, event, run and lease identifiers. Defaults to `crypto.randomUUID`. */
  readonly createId?: () => string;
  readonly queues?: {
    /** Attempts for queues that declare no `maxAttempts`. Default 5. */
    readonly defaultMaxAttempts?: number;
    /** How often waiting receivers look for work added by another process, in milliseconds of the clock. Default 1 000. */
    readonly pollIntervalMs?: number;
    /** How long acknowledged messages are kept for inspection, in milliseconds. Default 24 hours. */
    readonly retentionMs?: number;
  };
  readonly storage?: {
    /** Where signed URLs point; serve them with `storage.fetch`. Default `http://127.0.0.1:3000/_holqa/storage`. */
    readonly signedUrlBase?: string;
    /** The largest signed upload, in bytes. Default 100 MiB. */
    readonly maxUploadBytes?: number;
  };
}

/** Options of {@link LocalEnvironment.settle}. */
export interface SettleOptions {
  /** How long to wait, in real milliseconds. Default 10 000. */
  readonly timeoutMs?: number;
}

/**
 * A local environment: one binding that fulfils an application's queues,
 * buckets and schedules on this machine, plus inspection of their state.
 */
export interface LocalEnvironment {
  /** Pass it to `createRuntime({ binding })`. */
  readonly binding: RuntimeBinding;
  readonly clock: Clock;
  readonly queues: LocalQueues;
  readonly storage: LocalStorage;
  readonly scheduler: LocalScheduler;
  /**
   * Waits until no work is pending without moving the clock: no queue
   * message or object event that a runtime receives is due or in flight, and
   * no scheduled run is in progress. Delayed work waits for the clock.
   *
   * @throws {HolqaError} `HOLQA_INVOCATION_TIMEOUT` when work is still pending after `timeoutMs`, naming the busy channels.
   */
  readonly settle: (options?: SettleOptions) => Promise<void>;
  /** Closes the state database. Stop runtimes that use the binding first. */
  readonly close: () => void;
}

/** What the local binding advertises. It never promises more than common production services do. */
const localCapabilities: BindingCapabilities = Object.freeze({
  "queue": Object.freeze({ delivery: Object.freeze(["at-least-once" as const]), maxAttempts: 100, deadLetter: true, backoff: Object.freeze(["fixed" as const, "exponential" as const]), maxDelaySeconds: 900 }),
  "bucket": Object.freeze({ access: Object.freeze(["private" as const, "public-read" as const]), events: Object.freeze(["object.created" as const, "object.deleted" as const]), signedUrls: Object.freeze({ maxExpiresInSeconds: 604_800 }) }),
  "schedule": Object.freeze({ overlap: Object.freeze(["skip" as const, "allow" as const]) }),
  "http.api": Object.freeze({})
});

/**
 * Creates a local environment for an application: SQLite-backed queues with
 * leases, retries and dead-lettering; filesystem-backed buckets with events
 * and development signed URLs; a scheduler driven by an injectable clock; and
 * SQLite-backed operation budgets and idempotency keys, shared by every
 * process that uses the same state directory.
 *
 * @example
 * ```ts
 * const env = await createLocalEnvironment({ app, directory: ".holqa/local" });
 * const runtime = createRuntime({ app, handlers, binding: env.binding });
 * await runtime.start();
 * ```
 *
 * @param options - The application, state directory, clock and settings.
 * @returns The binding, inspection APIs and lifecycle of the environment.
 * @throws {HolqaError} `HOLQA_APP_INVALID`, `HOLQA_DECLARATION_INVALID` (malformed options), `HOLQA_CONFIG_INVALID` or `HOLQA_LOCAL_STATE_UNSUPPORTED`.
 */
export async function createLocalEnvironment(options: LocalEnvironmentOptions): Promise<LocalEnvironment> {
  const app = getAppDescriptor(options.app);
  if (app === undefined)
    throw new HolqaError(createDiagnostic({ code: diagnosticCodes.appInvalid, severity: "error", message: "The local environment was given a value that is not a Holqa application." }));
  checkOptions(options);
  const configuration = await createEnvironmentBinding(app, options.env ?? process.env);
  const clock = options.clock ?? systemClock;
  const createId = options.createId ?? (() => crypto.randomUUID());
  const database = openStateDatabase(options.directory);
  const store = new LeaseStore({
    database,
    clock,
    createId,
    pollIntervalMs: options.queues?.pollIntervalMs ?? 1_000,
    retentionMs: options.queues?.retentionMs ?? 86_400_000
  });
  const queues = createLocalQueues({ store, clock, createId, defaultMaxAttempts: options.queues?.defaultMaxAttempts ?? 5 });
  const access = new Map(app.resources.flatMap(resource => resource.kind === "bucket" ? [[resource.id, resource.requirements.access] as const] : []));
  const storage = createLocalStorage({
    database,
    store,
    clock,
    createId,
    directory: join(options.directory, "objects"),
    signedUrlBase: options.storage?.signedUrlBase ?? "http://127.0.0.1:3000/_holqa/storage",
    maxUploadBytes: options.storage?.maxUploadBytes ?? 100 * 1024 * 1024,
    access
  });
  const scheduler = createLocalScheduler({ database, clock, createId });

  const binding: RuntimeBinding = Object.freeze({
    name: "local",
    capabilities: localCapabilities,
    drivers: Object.freeze({ queue: queues.driver, bucket: storage.driver }),
    sources: Object.freeze({ queue: queues.source, bucket: storage.source, schedule: scheduler.source }),
    operationBudgets: createLocalOperationBudgets({ database, clock, createId }),
    idempotency: createLocalIdempotencyStore({ database, clock, createId }),
    config: configuration.config
  });

  return Object.freeze({
    binding,
    clock,
    queues: queues.queues,
    storage: storage.storage,
    scheduler: scheduler.scheduler,
    settle: async (settleOptions: SettleOptions = {}) => {
      const deadline = performance.now() + (settleOptions.timeoutMs ?? 10_000);
      for (;;) {
        await scheduler.scheduler.idle();
        const busy = store.busyChannels();
        if (busy.length === 0) {
          // Settlements can schedule follow-up work in the same tick; confirm once more.
          await Bun.sleep(1);
          if (store.busyChannels().length === 0)
            return;
        }
        if (performance.now() > deadline)
          throw new HolqaError(createDiagnostic({ code: diagnosticCodes.invocationTimeout, severity: "error", message: `Local work was still pending after ${settleOptions.timeoutMs ?? 10_000} ms: ${busy.join(", ")}.`, details: { channels: busy } }));
        await Bun.sleep(2);
      }
    },
    close: () => database.close()
  });
}

/**
 * Validates the numeric and URL settings of an environment, so that a typo
 * fails clearly instead of producing a busy loop or a raw `TypeError`.
 *
 * @param options - The untrusted options.
 * @throws {HolqaError} `HOLQA_DECLARATION_INVALID`, one diagnostic per invalid setting.
 */
function checkOptions(options: LocalEnvironmentOptions): void {
  const problems: Diagnostic[] = [];
  /**
   * Records a problem unless a value is absent or a positive safe integer.
   *
   * @param value - The candidate.
   * @param name - The option's name, for the message.
   */
  const positive = (value: unknown, name: string): void => {
    if (value !== undefined && !(typeof value === "number" && Number.isSafeInteger(value) && value >= 1))
      problems.push(createDiagnostic({ code: diagnosticCodes.declarationInvalid, severity: "error", message: `The local environment option "${name}" must be an integer of at least 1.` }));
  };
  if (typeof options.directory !== "string" || options.directory === "")
    problems.push(createDiagnostic({ code: diagnosticCodes.declarationInvalid, severity: "error", message: "The local environment option \"directory\" must be a non-empty path." }));
  positive(options.queues?.defaultMaxAttempts, "queues.defaultMaxAttempts");
  positive(options.queues?.pollIntervalMs, "queues.pollIntervalMs");
  positive(options.queues?.retentionMs, "queues.retentionMs");
  positive(options.storage?.maxUploadBytes, "storage.maxUploadBytes");
  const base = options.storage?.signedUrlBase;
  if (base !== undefined && !(typeof base === "string" && URL.canParse(base) && /^https?:$/.test(new URL(base).protocol)))
    problems.push(createDiagnostic({ code: diagnosticCodes.declarationInvalid, severity: "error", message: "The local environment option \"storage.signedUrlBase\" must be an absolute http or https URL." }));
  if (problems.length > 0)
    throw new HolqaError(problems);
}