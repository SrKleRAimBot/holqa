import type {
  BindingProvider,
  ProviderInstance
} from "@holqa/core";

import { bindingProtocolVersion } from "@holqa/core";

/** Environment variables by name, as `process.env` provides them. */
export type EnvironmentVariables = Readonly<Record<string, string | undefined>>;

/** Settings of {@link environmentConfig}. */
export interface EnvironmentConfigOptions {
  /** The variables to read. Defaults to `process.env` when the runtime has one. */
  readonly env?: EnvironmentVariables;
  /** The provider instance's name. Default `environment`. */
  readonly name?: string;
}

/**
 * A configuration service provider that reads configuration values and
 * credentials from environment variables, by name. It is what a binding
 * configuration uses when neither `services.config` nor the default provider
 * supplies configuration.
 *
 * @example
 * ```ts
 * defineBindings(app, { defaults: local.platform(), services: { config: environmentConfig() } });
 * ```
 *
 * @param options - The variables to read and the provider's name.
 * @returns A service provider for the `config` contract.
 */
export function environmentConfig(options: EnvironmentConfigOptions = {}): BindingProvider<never, "config"> {
  return Object.freeze({
    bindingProtocol: bindingProtocolVersion,
    provider: "holqa.environment",
    name: options.name ?? "environment",
    role: "service",
    contracts: Object.freeze({ config: 1 }),
    resources: Object.freeze({}),
    services: Object.freeze({ config: true }),
    topology: Object.freeze({ delivery: "none", state: "process" }),
    open: async (): Promise<ProviderInstance> => {
      const env = options.env ?? (globalThis as { readonly process?: { readonly env?: EnvironmentVariables } }).process?.env ?? {};
      return Object.freeze({ config: Object.freeze({ lookup: (name: string) => env[name] }) });
    }
  } satisfies BindingProvider<never, "config">);
}