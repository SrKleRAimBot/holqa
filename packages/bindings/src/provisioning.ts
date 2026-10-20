import type {
  AnyBindingProvider,
  AppliedChange,
  BindingLogLevel,
  CredentialReference,
  DeliveredHandler,
  Diagnostic,
  JsonObject,
  PlannedChange,
  Provisioner,
  ProvisioningContext,
  ResourceDescriptor
} from "@holqa/core";

import type { BindingsDefinition } from "@/define-bindings";

import {
  bindingFailure,
  createDiagnostic,
  diagnosticCodes,
  diagnosticsOf,
  HolqaError,
  provisioningProtocolVersion
} from "@holqa/core";

import { isBindingsDefinition } from "@/define-bindings";
import { resolveBindings } from "@/resolve";

/** The format tag of a provisioning plan. */
export const provisioningPlanFormat = "holqa.provisioning-plan/1";

/** The format tag of a provisioning result. */
export const provisioningResultFormat = "holqa.provisioning-result/1";

/** A provisioning configuration: which provisioners manage the infrastructure of one binding configuration. */
export interface ProvisioningDefinition {
  readonly type: "holqa.provisioning";
  readonly bindings: BindingsDefinition;
  readonly provisioners: readonly Provisioner[];
}

/** A resource whose infrastructure no provisioner manages: it must exist already. */
export interface UnprovisionedResource {
  readonly resource: string;
  readonly provider: string;
}

/** The plan for one binding configuration, as plain data without credential values. */
export interface ProvisioningPlan {
  readonly format: typeof provisioningPlanFormat;
  /** The binding configuration's name. */
  readonly binding: string;
  readonly application: string;
  /** Every change of every provisioner, in apply order, including `none`. */
  readonly changes: readonly PlannedChange[];
  /** Resources no provisioner manages, sorted. */
  readonly unprovisioned: readonly UnprovisionedResource[];
  /** Each provisioner's non-secret outputs, by provisioner name. */
  readonly outputs: Readonly<Record<string, JsonObject>>;
  readonly diagnostics: readonly Diagnostic[];
}

/** The outcome of applying a plan. */
export interface ProvisioningResult {
  readonly format: typeof provisioningResultFormat;
  readonly binding: string;
  readonly application: string;
  /** Every change that was attempted, in order; changes after a failure are absent. */
  readonly applied: readonly AppliedChange[];
  readonly diagnostics: readonly Diagnostic[];
}

/** What planning and applying need besides the configuration. */
export interface ProvisioningOptions {
  /** The application's handlers, for example a manifest's `handlers`, for infrastructure per subscription. */
  readonly handlers: readonly DeliveredHandler[];
  /** Looks up a credential's value by name, for example in the process environment. */
  readonly lookup: (name: string) => string | undefined;
  readonly signal?: AbortSignal;
  readonly log?: (level: BindingLogLevel, message: string, fields?: JsonObject) => void;
}

/** Settings of {@link applyProvisioning}. */
export interface ApplyProvisioningOptions extends ProvisioningOptions {
  /** Apply `replace` and `delete` changes too. Default `false`: a plan with one applies nothing. */
  readonly allowDestructive?: boolean;
}

/**
 * Builds an `HOLQA_PROVISIONING_CONFIG_INVALID` error.
 *
 * @param problems - One sentence per problem.
 * @returns The error.
 */
function invalid(problems: readonly string[]): HolqaError {
  return new HolqaError(problems.map(message => createDiagnostic({ code: diagnosticCodes.provisioningConfigInvalid, severity: "error", message: `defineProvisioning: ${message}` })));
}

/**
 * Declares which provisioners manage the infrastructure of a binding
 * configuration, conventionally in `provisioning.ts` next to the bindings
 * module. Pure: creates no connection and reads no environment. A resource
 * no provisioner supports is reported as unprovisioned, never an error: its
 * infrastructure is expected to exist.
 *
 * @example
 * ```ts
 * export default defineProvisioning(bindings, { provisioners: [rabbitmq.provisioner({ url: credentialRef("RABBITMQ_ADMIN_URL") })] });
 * ```
 *
 * @param bindings - The binding configuration whose infrastructure is provisioned.
 * @param config - The provisioners.
 * @param config.provisioners - Provisioners, each with a distinct name.
 * @returns The frozen provisioning configuration.
 * @throws {HolqaError} `HOLQA_PROVISIONING_CONFIG_INVALID` for a malformed configuration or provisioner.
 */
export function defineProvisioning(bindings: BindingsDefinition, config: { readonly provisioners: readonly Provisioner[] }): ProvisioningDefinition {
  const problems: string[] = [];
  if (!isBindingsDefinition(bindings))
    problems.push("the first argument must be a binding configuration created by defineBindings.");
  const provisioners: unknown = config?.provisioners;
  if (!Array.isArray(provisioners) || provisioners.length === 0) {
    problems.push("\"provisioners\" must list at least one provisioner.");
  } else {
    const names = new Set<string>();
    for (const [index, candidate] of (provisioners as unknown[]).entries()) {
      const provisioner = candidate as Partial<Provisioner> | null;
      if (typeof provisioner !== "object" || provisioner === null || typeof provisioner.name !== "string" || typeof provisioner.plan !== "function" || typeof provisioner.apply !== "function" || typeof provisioner.supports !== "function") {
        problems.push(`provisioners[${index}] is not a provisioner.`);
        continue;
      }
      if (provisioner.provisioningProtocol !== provisioningProtocolVersion)
        problems.push(`provisioner "${provisioner.name}" implements provisioning protocol ${String(provisioner.provisioningProtocol)}, but this version of Holqa implements ${provisioningProtocolVersion}.`);
      if (names.has(provisioner.name))
        problems.push(`two provisioners are named "${provisioner.name}".`);
      names.add(provisioner.name);
    }
  }
  if (problems.length > 0)
    throw invalid(problems);
  return Object.freeze({ type: "holqa.provisioning", bindings, provisioners: Object.freeze([...provisioners as readonly Provisioner[]]) });
}

/**
 * Reports whether a value is a provisioning configuration created by
 * `defineProvisioning`, for example the default export of `provisioning.ts`.
 *
 * @param value - The candidate.
 * @returns `true` for a provisioning configuration.
 */
export function isProvisioningDefinition(value: unknown): value is ProvisioningDefinition {
  return typeof value === "object" && value !== null && (value as { readonly type?: unknown }).type === "holqa.provisioning" && isBindingsDefinition((value as { readonly bindings?: unknown }).bindings);
}

/** One provisioner with the resources it claimed. */
interface Claim {
  readonly provisioner: Provisioner;
  readonly resources: readonly { readonly resource: ResourceDescriptor; readonly provider: AnyBindingProvider }[];
}

/**
 * Builds the context a provisioner plans and applies with.
 *
 * @param definition - The provisioning configuration.
 * @param claim - The provisioner and its resources.
 * @param options - Handlers, credential lookup, signal and log.
 * @returns A context whose credential lookup is limited to the provisioner's declared references.
 */
function contextOf(definition: ProvisioningDefinition, claim: Claim, options: ProvisioningOptions): ProvisioningContext {
  const { provisioner } = claim;
  return Object.freeze({
    app: definition.bindings.app,
    environment: definition.bindings.name,
    resources: claim.resources,
    handlers: options.handlers,
    credential: (reference: CredentialReference): string => {
      if (!(provisioner.credentials ?? []).some(declared => declared.name === reference.name))
        throw new HolqaError(bindingFailure("configuration", { binding: provisioner.name, message: `Provisioner "${provisioner.name}" asked for the credential ${reference.name}, which it does not declare.` }));
      const value = options.lookup(reference.name);
      if (value === undefined || value === "")
        throw new HolqaError(bindingFailure("credentials-missing", { binding: provisioner.name, message: `The credential ${reference.name} that provisioner "${provisioner.name}" needs is not set.`, hint: `Set ${reference.name} where provisioning runs; the application's runtime does not need it.`, details: { credential: reference.name } }));
      return value;
    },
    signal: options.signal ?? new AbortController().signal,
    log: options.log ?? (() => {})
  });
}

/**
 * Converts a provisioner failure into diagnostics.
 *
 * @param provisioner - The provisioner's name.
 * @param error - What it threw.
 * @param phase - `plan` or `apply`, for the message.
 * @returns Classified diagnostics, or `HOLQA_PROVISIONING_FAILED`.
 */
function failure(provisioner: string, error: unknown, phase: "plan" | "apply"): Diagnostic[] {
  const diagnostics = diagnosticsOf(error);
  if (diagnostics.length > 0)
    return [...diagnostics];
  return [createDiagnostic({ code: diagnosticCodes.provisioningFailed, severity: "error", message: `Provisioner "${provisioner}" failed to ${phase}: ${error instanceof Error ? error.message : String(error)}`, details: { provisioner } })];
}

/**
 * Resolves the binding configuration and lets each provisioner claim resources.
 *
 * @param definition - The provisioning configuration.
 * @returns The claims, unprovisioned resources and resolution problems.
 */
function claimResources(definition: ProvisioningDefinition): { readonly claims: readonly Claim[]; readonly unprovisioned: readonly UnprovisionedResource[]; readonly diagnostics: readonly Diagnostic[] } {
  const resolved = resolveBindings(definition.bindings);
  if (resolved.diagnostics.some(diagnostic => diagnostic.severity === "error"))
    return { claims: [], unprovisioned: [], diagnostics: resolved.diagnostics };
  const claims = definition.provisioners.map(provisioner => ({ provisioner, resources: resolved.resources.filter(({ provider, resource }) => provisioner.supports(provider, resource)).map(({ resource, provider }) => ({ resource, provider })) }));
  const unprovisioned = resolved.resources
    .filter(({ resource }) => !claims.some(claim => claim.resources.some(claimed => claimed.resource.id === resource.id)))
    .map(({ resource, provider }) => ({ resource: resource.id as string, provider: provider.name }));
  return { claims: claims.filter(claim => claim.resources.length > 0), unprovisioned, diagnostics: resolved.diagnostics };
}

/**
 * Plans provisioning: resolves the binding configuration, lets each
 * provisioner claim the resources bound to runtime providers it understands,
 * and asks each for the changes that make the infrastructure match. Planning
 * only reads infrastructure. Two provisioners planning the same target are an
 * error. A failing provisioner is reported, and the others still plan.
 *
 * @param definition - The provisioning configuration.
 * @param options - Handlers, credential lookup, signal and log.
 * @returns The plan; it can be applied when `diagnostics` has no error.
 */
export async function planProvisioning(definition: ProvisioningDefinition, options: ProvisioningOptions): Promise<ProvisioningPlan> {
  const { claims, unprovisioned, diagnostics: resolution } = claimResources(definition);
  const diagnostics: Diagnostic[] = [...resolution];
  const changes: PlannedChange[] = [];
  const outputs: Record<string, JsonObject> = {};
  for (const claim of claims) {
    try {
      const plan = await claim.provisioner.plan(contextOf(definition, claim, options));
      changes.push(...plan.changes);
      diagnostics.push(...plan.diagnostics);
      if (plan.outputs !== undefined)
        outputs[claim.provisioner.name] = plan.outputs;
    } catch (error) {
      diagnostics.push(...failure(claim.provisioner.name, error, "plan"));
    }
  }
  const targets = new Map<string, string>();
  for (const change of changes) {
    const key = `${change.type} ${change.target}`;
    const other = targets.get(key);
    if (other !== undefined && other !== change.provisioner)
      diagnostics.push(createDiagnostic({ code: diagnosticCodes.provisioningConfigInvalid, severity: "error", message: `Provisioners "${other}" and "${change.provisioner}" both manage the ${change.type} "${change.target}".`, details: { target: change.target, type: change.type } }));
    targets.set(key, change.provisioner);
  }
  return Object.freeze({
    format: provisioningPlanFormat,
    binding: definition.bindings.name,
    application: definition.bindings.app.name,
    changes: Object.freeze(changes),
    unprovisioned: Object.freeze([...unprovisioned].sort((left, right) => left.resource < right.resource ? -1 : 1)),
    outputs: Object.freeze(outputs),
    diagnostics: Object.freeze(diagnostics)
  });
}

/**
 * Plans and applies provisioning. Nothing is applied when the fresh plan has
 * an error, or when it contains a destructive change (`replace`, `delete`)
 * and `allowDestructive` is not set (`HOLQA_PROVISIONING_DESTRUCTIVE`).
 * Otherwise each provisioner applies its changes in order, skipping `none`,
 * and applying stops at the first failure: what was applied before stays
 * applied and is listed in the result.
 *
 * @param definition - The provisioning configuration.
 * @param options - Handlers, credential lookup, authorization of destructive changes, signal and log.
 * @returns The plan that was applied and the outcome of each change.
 */
export async function applyProvisioning(definition: ProvisioningDefinition, options: ApplyProvisioningOptions): Promise<{ readonly plan: ProvisioningPlan; readonly result: ProvisioningResult }> {
  const plan = await planProvisioning(definition, options);
  /**
   * Builds the result document.
   *
   * @param applied - The attempted changes.
   * @param diagnostics - The problems.
   * @returns The frozen result.
   */
  const result = (applied: readonly AppliedChange[], diagnostics: readonly Diagnostic[]): ProvisioningResult => Object.freeze({ format: provisioningResultFormat, binding: plan.binding, application: plan.application, applied: Object.freeze([...applied]), diagnostics: Object.freeze([...diagnostics]) });
  if (plan.diagnostics.some(diagnostic => diagnostic.severity === "error"))
    return { plan, result: result([], plan.diagnostics.filter(diagnostic => diagnostic.severity === "error")) };
  const destructive = plan.changes.filter(change => change.destructive);
  if (destructive.length > 0 && options.allowDestructive !== true) {
    return {
      plan,
      result: result([], destructive.map(change => createDiagnostic({ code: diagnosticCodes.provisioningDestructive, severity: "error", message: `The plan would ${change.action} the ${change.type} "${change.target}": ${change.reason}`, hint: "Nothing was applied. Migrate the data and change the infrastructure yourself, or apply with explicit authorization of destructive changes.", details: { provisioner: change.provisioner, type: change.type, target: change.target, action: change.action } })))
    };
  }
  const { claims } = claimResources(definition);
  const applied: AppliedChange[] = [];
  for (const claim of claims) {
    const changes = plan.changes.filter(change => change.provisioner === claim.provisioner.name && change.action !== "none");
    if (changes.length === 0)
      continue;
    try {
      const outcome = await claim.provisioner.apply(contextOf(definition, claim, options), changes);
      applied.push(...outcome);
      const failed = outcome.find(item => item.status === "failed");
      if (failed !== undefined)
        return { plan, result: result(applied, [createDiagnostic({ code: diagnosticCodes.provisioningFailed, severity: "error", message: `Provisioner "${claim.provisioner.name}" failed to ${failed.change.action} the ${failed.change.type} "${failed.change.target}": ${failed.message ?? "no details"}`, details: { provisioner: claim.provisioner.name, target: failed.change.target } })]) };
    } catch (error) {
      return { plan, result: result(applied, failure(claim.provisioner.name, error, "apply")) };
    }
  }
  return { plan, result: result(applied, []) };
}