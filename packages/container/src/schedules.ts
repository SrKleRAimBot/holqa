import type {
  BindingProvider,
  ProviderContext,
  ProviderInstance
} from "@holqa/core";

import { bindingProtocolVersion } from "@holqa/core";
import { localEnvironment } from "@holqa/local";

/** Settings of {@link schedules}. */
export interface ContainerSchedulesOptions {
  /** The provider's name. Default `container.schedules`. */
  readonly name?: string;
}

/**
 * Creates an in-process scheduler for a container: it evaluates each
 * schedule's cron expression and time zone in the application process and
 * starts runs through the shared runtime, with the same overlap policies
 * (`skip`, `allow`), daylight-saving rules and missed-run behaviour as the
 * local scheduler. Runs due while the process is not running are not
 * backfilled; when the process wakes up late, only the latest due run starts.
 *
 * Its state lives in the process (`topology.state: "process"`), so every
 * replica would run every schedule: binding configurations that declare
 * more than one replica are rejected (`HOLQA_BINDING_TOPOLOGY_UNSUPPORTED`).
 * Use an external scheduler for several replicas.
 *
 * @param options - The provider's name.
 * @returns A resource provider for schedules.
 */
export function schedules(options: ContainerSchedulesOptions = {}): BindingProvider<"schedule"> {
  const inner = localEnvironment({ name: "container", persistence: "memory", telemetry: false }).schedules();
  return Object.freeze({
    ...inner,
    provider: "holqa.container",
    name: options.name ?? "container.schedules",
    bindingProtocol: bindingProtocolVersion,
    topology: Object.freeze({ delivery: "pull", state: "process" }),
    settings: Object.freeze({ scheduler: "in-process" }),
    /**
     * Opens the in-memory scheduler state.
     *
     * @param context - The provider context.
     * @returns The instance with the schedule source.
     */
    open: async (context: ProviderContext): Promise<ProviderInstance> => inner.open(context)
  });
}