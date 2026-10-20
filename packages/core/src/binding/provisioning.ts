import type { AppDescriptor } from "@/app/app-descriptor";
import type { DeliveredHandler } from "@/binding/delivery-check";
import type { BindingLogLevel } from "@/binding/lifecycle";
import type {
  AnyBindingProvider,
  CredentialReference
} from "@/binding/provider";
import type { Diagnostic } from "@/diagnostics/diagnostic";
import type { JsonObject } from "@/json";
import type { ResourceDescriptor } from "@/resources/resource-descriptor";

// Provisioning is separate from runtime bindings. A runtime provider connects
// to infrastructure that exists and needs only data-plane permissions; a
// provisioner, optionally and with its own credentials, inspects that
// infrastructure, plans changes and applies the ones an operator authorized.
// Infrastructure created by Terraform, Pulumi or by hand is equally valid: a
// provisioner is never required to run an application.

/** The version of the provisioning protocol this copy of Holqa implements. */
export const provisioningProtocolVersion = 1;

/**
 * What a planned change does to one piece of infrastructure:
 *
 * - `create`: it does not exist;
 * - `update`: it exists and can be changed in place without losing data;
 * - `replace`: it exists with settings that cannot be changed in place, so it would be deleted and created again, losing what it holds;
 * - `delete`: it would be removed;
 * - `none`: it exists as needed.
 *
 * Provisioners never plan `delete` for infrastructure because a resource
 * declaration was removed: the protocol has no notion of orphans, and
 * deleting infrastructure is always an explicit operator action outside it.
 */
export type ProvisioningAction = "create" | "update" | "replace" | "delete" | "none";

/** One planned change, as plain data. */
export interface PlannedChange {
  /** The provisioner that planned and applies it. */
  readonly provisioner: string;
  /** The type of infrastructure, namespaced, for example `rabbitmq.queue` or `s3.bucket`. */
  readonly type: string;
  /** The physical name, for example the queue or bucket name. */
  readonly target: string;
  /** The Holqa resource it serves, when it serves one. */
  readonly resource?: string;
  readonly action: ProvisioningAction;
  /** `true` for `replace` and `delete`: applying it loses data and needs explicit authorization. */
  readonly destructive: boolean;
  /** Why, in one sentence. */
  readonly reason: string;
  /** The desired settings, and for updates and replacements what differs. Never credential values. */
  readonly details?: JsonObject;
}

/** The outcome of applying one change. */
export interface AppliedChange {
  readonly change: PlannedChange;
  readonly status: "applied" | "skipped" | "failed";
  /** For `failed` and `skipped`, why. */
  readonly message?: string;
}

/** What a provisioner receives for planning and applying. */
export interface ProvisioningContext {
  readonly app: AppDescriptor;
  /** The binding configuration's name, usually the environment. */
  readonly environment: string;
  /**
   * The resolved selections: each resource with its runtime provider, so a
   * provisioner derives the infrastructure from the runtime provider's
   * settings and never from separate configuration that could disagree.
   */
  readonly resources: readonly { readonly resource: ResourceDescriptor; readonly provider: AnyBindingProvider }[];
  /** The application's handlers, for infrastructure per subscription (for example a queue per object event handler). */
  readonly handlers: readonly DeliveredHandler[];
  /** Resolves one of the provisioner's own credential references. */
  readonly credential: (reference: CredentialReference) => string;
  readonly signal: AbortSignal;
  readonly log: (level: BindingLogLevel, message: string, fields?: JsonObject) => void;
}

/** A provisioner's plan. */
export interface ProvisionerPlan {
  /** Every change, including `none` for infrastructure that is as needed, in apply order. */
  readonly changes: readonly PlannedChange[];
  /** Problems, for example a resource the provisioner cannot provision. */
  readonly diagnostics: readonly Diagnostic[];
  /** Non-secret metadata of the infrastructure, for example queue names and notification targets. */
  readonly outputs?: JsonObject;
}

/**
 * A provisioner: side-effect-free data plus `plan` and `apply`. It claims the
 * resources bound to the runtime providers it understands (`supports`), and
 * resolves only the credentials it declares, which are separate from the
 * runtime's.
 */
export interface Provisioner {
  /** The provisioning protocol version, {@link provisioningProtocolVersion}. */
  readonly provisioningProtocol: number;
  /** The implementation's namespaced identifier, for example `holqa.rabbitmq.provisioner`. */
  readonly provisioner: string;
  /** This configured instance's name, for plans and diagnostics. */
  readonly name: string;
  /** Non-secret settings. */
  readonly settings?: JsonObject;
  /** The credentials it needs, typically administrative ones the runtime never receives. */
  readonly credentials?: readonly CredentialReference[];
  /**
   * Reports whether it provisions the infrastructure of a resource bound to
   * a runtime provider. Pure.
   */
  readonly supports: (provider: AnyBindingProvider, resource: ResourceDescriptor) => boolean;
  /**
   * Inspects the current infrastructure of the supported resources and plans
   * the changes that make it match. Reading only: planning changes nothing.
   */
  readonly plan: (context: ProvisioningContext) => Promise<ProvisionerPlan>;
  /**
   * Applies changes it planned, in order, and stops at the first failure.
   * The engine passes only authorized changes; a provisioner must not apply
   * anything else.
   */
  readonly apply: (context: ProvisioningContext, changes: readonly PlannedChange[]) => Promise<readonly AppliedChange[]>;
}