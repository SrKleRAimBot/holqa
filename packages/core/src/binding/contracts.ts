// Binding contracts are the infrastructure-facing half of Holqa's resource
// model. Each contract is versioned on its own, so a provider can implement
// version 1 of the queue contract while the bucket contract moves on, and a
// runtime can tell which providers it understands before it opens any of
// them. A contract version changes only when the meaning of an operation or
// of a capability changes in a way an existing provider could violate.

/** The version of the provider protocol itself: the shape of providers, instances, lifecycle and capability declarations. */
export const bindingProtocolVersion = 1;

/** The literal type of {@link bindingProtocolVersion}. */
export type BindingProtocolVersion = typeof bindingProtocolVersion;

/**
 * Every binding contract this version of Holqa defines, with the version it
 * implements. Resource contracts are named after the resource kind they bind;
 * `bucket.events` is separate from `bucket` because object storage and its
 * event notifications are often different infrastructure. The other
 * contracts are not resources: `execution` is the host that runs the
 * invocation engine, `config` resolves configuration values and credentials,
 * `telemetry` exports traces, metrics and logs, and `idempotency` and
 * `operation-budgets` are the shared stores of event safety.
 */
export const bindingContracts = Object.freeze({
  "execution": 1,
  "http.api": 1,
  "queue": 1,
  "bucket": 1,
  "bucket.events": 1,
  "schedule": 1,
  "config": 1,
  "telemetry": 1,
  "idempotency": 1,
  "operation-budgets": 1
} as const);

/** The name of a binding contract, for example `queue` or `bucket.events`. */
export type BindingContractName = keyof typeof bindingContracts;

/** Every binding contract name, in a stable order. */
export const bindingContractNames: readonly BindingContractName[] = Object.freeze(Object.keys(bindingContracts) as BindingContractName[]);

/**
 * The contracts a complete platform provider must implement. A provider that
 * declares the `platform` role but lacks one of them is rejected, so "complete
 * platform" always means the same thing. `idempotency` and
 * `operation-budgets` are optional: applications that need them (handlers
 * with an `idempotency` policy, a per-operation event budget) are rejected by
 * bindings without them.
 */
export const mandatoryBindingContracts: readonly BindingContractName[] = Object.freeze(["execution", "http.api", "queue", "bucket", "bucket.events", "schedule", "config", "telemetry"] as const);

/**
 * Reports whether a value names a binding contract this version defines.
 *
 * @param value - A candidate name, typically read from an untrusted provider.
 * @returns `true` for a defined contract name.
 */
export function isBindingContractName(value: unknown): value is BindingContractName {
  return typeof value === "string" && Object.hasOwn(bindingContracts, value);
}

/**
 * Compares the contract version a provider implements with the version this
 * copy of Holqa implements. Versions are whole numbers and must match
 * exactly: a newer contract may give an operation a meaning an older runtime
 * would not honour, and an older one may lack guarantees the runtime relies on.
 *
 * @param contract - The contract whose version is compared.
 * @param version - The version the provider declares.
 * @returns `undefined` when compatible, otherwise a sentence describing the mismatch.
 */
export function contractVersionProblem(contract: BindingContractName, version: unknown): string | undefined {
  const supported = bindingContracts[contract];
  if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 1)
    return `the ${contract} contract version must be a positive whole number, not ${JSON.stringify(version) ?? String(version)}`;
  return version === supported ? undefined : `it implements version ${version} of the ${contract} contract, but this version of Holqa implements version ${supported}`;
}