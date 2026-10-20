import type { AppDescriptor } from "@/app/app-descriptor";
import type { RuntimeBinding } from "@/binding/runtime-binding";
import type { ConfigDescriptor } from "@/config/config-descriptor";
import type {
  DrivenResourceKind,
  ResourceKind,
  ResourceKindMap
} from "@/resources/kinds";
import type { ResourceDescriptorOf } from "@/resources/resource-descriptor";

import { resourceBindingInfo } from "@/binding/runtime-binding";
import { diagnosticCodes } from "@/diagnostics/codes";
import { createDiagnostic } from "@/diagnostics/diagnostic";
import {
  failWith,
  HolqaError
} from "@/errors/holqa-error";
import { checkCapabilities } from "@/resources/capabilities";

/**
 * Installs a runtime binding on an application instance after checking that
 * the binding supports every declared resource: it must advertise capabilities
 * that satisfy each resource's requirements (per resource, when the binding
 * `describe`s resources individually) and provide a driver for each kind
 * that has operations. Rebinding a bound instance is rejected rather than
 * silently replacing the binding.
 *
 * @param app - The application descriptor.
 * @param binding - The binding to install.
 * @returns A function that removes this binding again; calling it more than once is harmless.
 * @throws {HolqaError} `HOLQA_RUNTIME_ALREADY_BOUND` when the instance already has a binding, or
 * `HOLQA_BINDING_CAPABILITY_UNSUPPORTED` (one diagnostic per shortfall) when the binding cannot serve the application.
 */
export function bindApp(app: AppDescriptor, binding: RuntimeBinding): () => void {
  if (app.binding.current !== undefined) {
    failWith(
      diagnosticCodes.runtimeAlreadyBound,
      `Application "${app.name}" is already bound to runtime "${app.binding.current.name}".`,
      "Remove the previous binding first, or load a fresh application instance."
    );
  }
  const problems = app.resources.flatMap((resource) => {
    const info = resourceBindingInfo(binding, resource);
    return [
      ...checkCapabilities(resource, info.capabilities, info.binding),
      ...isDriven(resource.kind) && binding.drivers[resource.kind] === undefined
        ? [createDiagnostic({
          code: diagnosticCodes.bindingCapabilityUnsupported,
          severity: "error",
          message: `Binding "${info.binding}" has no ${resource.kind} driver, required by "${resource.id}".`,
          details: { resource: resource.id, kind: resource.kind, binding: info.binding, requirement: resource.kind }
        })]
        : []
    ];
  });
  if (problems.length > 0)
    throw new HolqaError(problems);

  app.binding.current = binding;
  return () => {
    if (app.binding.current === binding)
      app.binding.current = undefined;
  };
}

/**
 * Returns the runtime binding of an application instance, failing clearly when
 * there is none. Handles call this when an operation runs, never when they are
 * declared, so that importing `infra.ts` stays free of side effects.
 *
 * @param app - The application descriptor.
 * @param operation - What was attempted, for the message (for example `queue "orders" send`).
 * @returns The installed binding.
 * @throws {HolqaError} `HOLQA_RUNTIME_NOT_BOUND` when no binding is installed, for example during analysis or at module top level.
 */
export function requireBinding(app: AppDescriptor, operation: string): RuntimeBinding {
  const binding = app.binding.current;
  if (binding === undefined) {
    failWith(
      diagnosticCodes.runtimeNotBound,
      `${operation} was used while application "${app.name}" is not bound to a runtime.`,
      "Resource handles and configuration only work inside a runtime. Use them inside handlers or lazily, never at module top level."
    );
  }
  return binding;
}

/**
 * Resolves the driver that backs one logical resource in the application's
 * current binding. This is the single point where a logical handle meets an
 * implementation: the same handle resolves to a local driver, a test double or
 * an external service depending only on which binding is installed.
 *
 * @param app - The application that declares the resource.
 * @param resource - The resource descriptor.
 * @param operation - What was attempted, for messages.
 * @returns The driver for the resource.
 * @throws {HolqaError} `HOLQA_RUNTIME_NOT_BOUND` without a binding, or
 * `HOLQA_BINDING_CAPABILITY_UNSUPPORTED` when the binding has no driver for the resource's kind.
 */
export function resolveDriver<Kind extends DrivenResourceKind>(app: AppDescriptor, resource: ResourceDescriptorOf<Kind>, operation: string): ResourceKindMap[Kind]["driver"] {
  const binding = requireBinding(app, operation);
  const factory = binding.drivers[resource.kind] as ((resource: ResourceDescriptorOf<Kind>) => ResourceKindMap[Kind]["driver"]) | undefined;
  if (factory === undefined)
    failWith(diagnosticCodes.bindingCapabilityUnsupported, `Binding "${binding.name}" has no ${resource.kind} driver, required by "${resource.id}".`);
  return factory(resource);
}

/**
 * Reads a configuration value from the application's current binding.
 *
 * @param app - The application that declares the entry.
 * @param entry - The configuration entry.
 * @returns The value supplied by the binding.
 * @throws {HolqaError} `HOLQA_RUNTIME_NOT_BOUND` without a binding.
 */
export function readConfig(app: AppDescriptor, entry: ConfigDescriptor): unknown {
  return requireBinding(app, `env.${entry.name}`).config(entry);
}

/** Resource kinds that have drivers. Kept in sync with `DrivenResourceKind` by the `satisfies` clause. */
const drivenKinds = { queue: true, bucket: true } as const satisfies Record<DrivenResourceKind, true>;

/**
 * Reports whether resources of a kind perform operations through a driver.
 *
 * @param kind - A resource kind.
 * @returns `true` when bindings must provide a driver for the kind.
 */
function isDriven(kind: ResourceKind): kind is DrivenResourceKind {
  return Object.hasOwn(drivenKinds, kind);
}