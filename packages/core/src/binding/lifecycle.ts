import type { JsonObject } from "@/json";

// Every binding follows the same lifecycle, driven by the runtime that owns
// it, so initialization order, readiness and shutdown never depend on which
// provider fulfils a resource:
//
//  1. resolve configuration       (bindings: select a provider per resource and service)
//  2. validate contracts and capabilities, without connecting
//  3. acquire credentials and dependencies
//  4. initialize drivers           (`start`)
//  5. register handlers and subscriptions (the runtime consumes sources)
//  6. verify readiness             (`ready`)
//  7. execute operations
//  8. monitor health               (`health`)
//  9. drain or cancel work         (the runtime stops receiving and drains)
// 10. dispose connections          (`stop`)

/** How healthy a binding, or one of its components, is. */
export type HealthStatus = "healthy" | "degraded" | "unhealthy";

/** The health of one component of a binding, for example one provider. */
export interface ComponentHealth {
  /** The component's name, for example a provider's name. */
  readonly name: string;
  readonly status: HealthStatus;
  /** An operator-safe description of a problem. Never contains credentials. */
  readonly message?: string;
  /** Operator-safe JSON details, for example `{ "connected": false }`. */
  readonly details?: JsonObject;
}

/**
 * A binding's health: the worst status of its components, and each
 * component's own report. `degraded` means operations still work but
 * something needs attention, for example a broker connection that is being
 * re-established; `unhealthy` means operations fail.
 */
export interface BindingHealth {
  readonly status: HealthStatus;
  readonly components: readonly ComponentHealth[];
}

/** Settings of {@link BindingLifecycle.stop}. */
export interface BindingStopOptions {
  /**
   * Aborted when the stop exceeded its time limit. Implementations should
   * then abandon graceful steps (for example waiting for publisher
   * confirmations) and release what they hold.
   */
  readonly signal: AbortSignal;
}

/**
 * The lifecycle of a binding that holds connections or other resources. A
 * runtime calls `start` once before it installs the binding, `ready` once
 * after it has registered its subscriptions, `health` at any time while
 * running, and `stop` once after every invocation has drained (also when
 * `start` failed part-way, to release what was acquired). Every method is
 * optional; a binding without a lifecycle needs no initialization.
 */
export interface BindingLifecycle {
  /**
   * Acquires credentials, opens connections and initializes drivers. Rejects
   * with a `HolqaError` whose diagnostics classify the failure (see
   * `bindingFailureCodes`); a binding must never fall back to another
   * provider on its own.
   */
  readonly start?: (signal: AbortSignal) => Promise<void>;
  /** Resolves once the binding can serve operations and deliver events; rejects like `start`. */
  readonly ready?: (signal: AbortSignal) => Promise<void>;
  /** Reports the current health without throwing. */
  readonly health?: () => Promise<BindingHealth>;
  /** Disposes of connections, timers and subscriptions. Must be safe to call after a failed or partial start. */
  readonly stop?: (options: BindingStopOptions) => Promise<void>;
}

/** The order of health statuses, from best to worst. */
const severity: Readonly<Record<HealthStatus, number>> = { healthy: 0, degraded: 1, unhealthy: 2 };

/**
 * Combines component reports into a binding's health: the worst status of
 * any component, `healthy` when there are none.
 *
 * @param components - The components' reports.
 * @returns The combined health, with the components in the given order.
 */
export function combineHealth(components: readonly ComponentHealth[]): BindingHealth {
  const status = components.reduce<HealthStatus>((worst, component) => severity[component.status] > severity[worst] ? component.status : worst, "healthy");
  return Object.freeze({ status, components: Object.freeze([...components]) });
}