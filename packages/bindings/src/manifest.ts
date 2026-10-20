import type {
  BindingContractName,
  BindingProtocolVersion
} from "@holqa/core";

import type {
  BindingReport,
  ExtensionReport,
  ProviderReport,
  ResourceReport,
  ServiceReport
} from "@/inspect";

import {
  bindingContracts,
  bindingProtocolVersion,
  HolqaError
} from "@holqa/core";

/** The format tag of a binding manifest. */
export const bindingManifestFormat = "holqa.binding-manifest/1";

/** A process or piece of infrastructure a provider needs besides the application's own process. */
export interface ConnectorReport {
  /** The provider that needs it. */
  readonly provider: string;
  readonly connector: string;
}

/**
 * The environment-specific half of a deployment: which provider binds each
 * resource and service of one application in one environment, with every
 * provider's contracts, capabilities, non-secret settings, credential names
 * and required connectors. It is kept separate from the infrastructure-neutral
 * application manifest, which it names by fingerprint. It never contains
 * credential values.
 */
export interface BindingManifest {
  readonly format: typeof bindingManifestFormat;
  /** The binding configuration's name, usually the environment, for example `production`. */
  readonly name: string;
  readonly application: string;
  /** The `sha256:` fingerprint of the application manifest this binding was resolved against. */
  readonly applicationManifest: string;
  /** The provider protocol version and the contract versions of the Holqa that produced it, for compatibility checks. */
  readonly compatibility: {
    readonly bindingProtocol: BindingProtocolVersion;
    readonly contracts: Readonly<Record<BindingContractName, number>>;
  };
  /** Sorted by resource identifier. */
  readonly resources: readonly ResourceReport[];
  readonly services: readonly ServiceReport[];
  readonly extensions: readonly ExtensionReport[];
  /** In opening order. */
  readonly providers: readonly ProviderReport[];
  /** Every credential name any provider resolves at runtime, sorted. Names only. */
  readonly credentials: readonly string[];
  /** What must run or be configured besides the application process, in provider order. */
  readonly connectors: readonly ConnectorReport[];
}

/**
 * Builds the binding manifest of a validated binding configuration from its
 * report. The result is deterministic for the same configuration and
 * application manifest: it holds no timestamps, paths or credential values.
 *
 * @example
 * ```ts
 * const report = inspectBindings(resolveBindings(bindings), { handlers: manifest.handlers });
 * const bindingManifest = createBindingManifest(report, { applicationManifest: fingerprint });
 * ```
 *
 * @param report - A report from `inspectBindings`, with the application's handlers.
 * @param options - The application manifest the configuration was resolved against.
 * @param options.applicationManifest - Its `sha256:` fingerprint.
 * @returns The manifest as plain JSON data, ready for canonical serialization.
 * @throws {HolqaError} The report's error diagnostics, when the configuration is invalid: an invalid configuration has no manifest.
 */
export function createBindingManifest(report: BindingReport, options: { readonly applicationManifest: string }): BindingManifest {
  const errors = report.diagnostics.filter(diagnostic => diagnostic.severity === "error");
  if (errors.length > 0)
    throw new HolqaError(errors);
  return {
    format: bindingManifestFormat,
    name: report.name,
    application: report.application,
    applicationManifest: options.applicationManifest,
    compatibility: { bindingProtocol: bindingProtocolVersion, contracts: { ...bindingContracts } },
    resources: report.resources,
    services: report.services,
    extensions: report.extensions,
    providers: report.providers,
    credentials: [...new Set(report.providers.flatMap(provider => provider.credentials))].sort(),
    connectors: report.providers.flatMap(provider => (provider.topology.connectors ?? []).map(connector => ({ provider: provider.name, connector })))
  };
}