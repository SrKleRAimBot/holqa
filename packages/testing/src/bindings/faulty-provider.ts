import type {
  BindingFailureKind,
  BindingProvider,
  BindingServiceName,
  BucketDriver,
  ComponentHealth,
  DeliverySource,
  ObjectEventSource,
  ProviderContext,
  ProviderInstance,
  QueueDriver,
  QueueSource,
  ResourceKind
} from "@holqa/core";

import {
  bindingFailure,
  HolqaError
} from "@holqa/core";

/**
 * Failures to inject into a provider, for testing how an application and the
 * runtime behave when infrastructure misbehaves. Counters apply to the next
 * calls and run down; every injected failure is a classified binding failure,
 * as a real provider would report it.
 */
export interface ProviderFaults {
  /** Makes `open` fail with this kind, for example `unavailable` or `credentials-invalid`. */
  readonly open?: BindingFailureKind;
  /** Makes `open` wait until the start's signal aborts, as a hanging connection would. */
  readonly openHangs?: boolean;
  /** Makes `ready` fail with this kind. */
  readonly ready?: BindingFailureKind;
  /** Fails the next this many queue sends, bucket writes and bucket reads with `HOLQA_BINDING_UNAVAILABLE`. */
  readonly operationFailures?: number;
  /** Fails the next this many `receive` calls of every source, as a lost connection would. */
  readonly receiveFailures?: number;
  /** Delays every driver operation by this many milliseconds, for time limit tests. */
  readonly latencyMs?: number;
  /** Makes settlements report a lost lease (resolve to `false`) for the next this many calls. */
  readonly lostLeases?: number;
  /** Makes `stop` fail. The provider still releases what it holds. */
  readonly stopFails?: boolean;
  /** The health the provider reports. Default: what the provider itself reports. */
  readonly health?: ComponentHealth["status"];
}

/** Counters of what a faulty provider did, for assertions. */
export interface FaultCounters {
  opened: number;
  stopped: number;
  injectedFailures: number;
}

/**
 * Wraps a provider so that it fails in controlled ways, keeping its
 * declaration (contracts, capabilities, name). The wrapped provider is opened
 * normally unless `open` or `openHangs` asks otherwise, and its drivers and
 * sources are wrapped to inject operation and receive failures, latency and
 * lost leases.
 *
 * @example
 * ```ts
 * const broker = withFaults(local.queues({ persistence: "memory" }), { receiveFailures: 2 });
 * ```
 *
 * @param provider - The provider to wrap.
 * @param faults - What to inject.
 * @returns The wrapped provider and its counters.
 */
export function withFaults<Kinds extends ResourceKind, Services extends BindingServiceName>(provider: BindingProvider<Kinds, Services>, faults: ProviderFaults): BindingProvider<Kinds, Services> & { readonly counters: FaultCounters } {
  const counters: FaultCounters = { opened: 0, stopped: 0, injectedFailures: 0 };
  let operationFailures = faults.operationFailures ?? 0;
  let receiveFailures = faults.receiveFailures ?? 0;
  let lostLeases = faults.lostLeases ?? 0;
  /**
   * Builds an injected failure.
   *
   * @param kind - The classification the failure carries.
   * @param message - What failed.
   * @returns The error to throw.
   */
  const failure = (kind: BindingFailureKind, message: string): HolqaError => {
    counters.injectedFailures += 1;
    return new HolqaError(bindingFailure(kind, { binding: provider.name, message: `Injected fault: ${message}` }));
  };
  /**
   * Applies latency and operation failures before a driver operation.
   *
   * @param operation - The operation, for the message.
   */
  const before = async (operation: string): Promise<void> => {
    if (faults.latencyMs !== undefined)
      await Bun.sleep(faults.latencyMs);
    if (operationFailures > 0) {
      operationFailures -= 1;
      throw failure("unavailable", `${operation} could not reach the infrastructure.`);
    }
  };
  /**
   * Wraps a settlement so that it can report a lost lease.
   *
   * @param settle - The original settlement.
   * @returns The wrapped settlement.
   */
  const settlement = <Args extends unknown[]>(settle: (...args: Args) => Promise<boolean>) => async (...args: Args): Promise<boolean> => {
    if (lostLeases > 0) {
      lostLeases -= 1;
      counters.injectedFailures += 1;
      return false;
    }
    return settle(...args);
  };
  /**
   * Wraps a delivery source.
   *
   * @param source - The original source.
   * @returns The wrapped source.
   */
  const source = <Source extends DeliverySource<unknown>>(source: Source): Source => ({
    ...source,
    receive: async (request) => {
      if (receiveFailures > 0) {
        receiveFailures -= 1;
        throw failure("unavailable", "the connection was lost while receiving.");
      }
      return source.receive(request);
    },
    acknowledge: settlement(source.acknowledge),
    retry: settlement(source.retry),
    deadLetter: settlement(source.deadLetter),
    discard: settlement(source.discard)
  });
  /**
   * Wraps the drivers and sources of an opened instance.
   *
   * @param instance - The original instance.
   * @returns The wrapped instance.
   */
  const wrap = (instance: ProviderInstance): ProviderInstance => {
    const queue = instance.drivers?.queue;
    const bucket = instance.drivers?.bucket;
    const queueSource = instance.sources?.queue;
    const bucketSource = instance.sources?.bucket;
    return {
      ...instance,
      drivers: {
        ...instance.drivers,
        ...queue === undefined
          ? {}
          : {
            queue: (resource): QueueDriver => {
              const driver = queue(resource);
              return { send: async (...args) => {
                await before(`sending to queue "${resource.id}"`);
                return driver.send(...args);
              } };
            }
          },
        ...bucket === undefined
          ? {}
          : {
            bucket: (resource): BucketDriver => {
              const driver = bucket(resource);
              return {
                ...driver,
                put: async (...args) => {
                  await before(`writing to bucket "${resource.id}"`);
                  return driver.put(...args);
                },
                get: async (...args) => {
                  await before(`reading from bucket "${resource.id}"`);
                  return driver.get(...args);
                }
              };
            }
          }
      },
      sources: {
        ...instance.sources,
        ...queueSource === undefined ? {} : { queue: (resource): QueueSource => source(queueSource(resource)) },
        ...bucketSource === undefined ? {} : { bucket: (resource): ObjectEventSource => ({ subscribe: async subscription => source(await bucketSource(resource).subscribe(subscription)) }) }
      },
      ready: async (signal) => {
        if (faults.ready !== undefined)
          throw failure(faults.ready, "the provider never became ready.");
        await instance.ready?.(signal);
      },
      health: async () => faults.health === undefined ? await instance.health?.() ?? { status: "healthy" } : { status: faults.health, message: "Injected health." },
      stop: async (options) => {
        counters.stopped += 1;
        await instance.stop?.(options);
        if (faults.stopFails === true)
          throw failure("failed", "stopping failed.");
      }
    };
  };
  return Object.freeze({
    ...provider,
    counters,
    open: async (context: ProviderContext) => {
      counters.opened += 1;
      if (faults.openHangs === true) {
        await new Promise<void>(resolve => context.signal.addEventListener("abort", () => resolve(), { once: true }));
        throw failure("unavailable", "opening timed out.");
      }
      if (faults.open !== undefined)
        throw failure(faults.open, "opening failed.");
      return wrap(await provider.open(context));
    }
  });
}