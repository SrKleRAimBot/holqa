import type {
  BindableApp,
  BindingsDefinition
} from "@holqa/bindings";
import type {
  Diagnostic,
  RuntimeBinding
} from "@holqa/core";
import type {
  LocalEnvironment,
  OpenedLocalState
} from "@holqa/local";
import type { Runtime } from "@holqa/runtime-bun";

import { pathToFileURL } from "node:url";

import {
  createBinding,
  defineBindings,
  isBindingsDefinition,
  resolveBindings,
  validateBindings
} from "@holqa/bindings";
import {
  createDiagnostic,
  diagnosticCodes,
  getAppDescriptor,
  HolqaError
} from "@holqa/core";
import {
  localEnvironment,
  localStateOf,
  systemClock
} from "@holqa/local";

/** Where the development binding comes from and what the default local platform uses. */
export interface DevBindingOptions {
  /** The local state directory of the default local platform. */
  readonly stateDir: string;
  /** The application root, for static sites. */
  readonly root: string;
  /** Where signed URLs of the default local platform point. */
  readonly signedUrlBase: string;
  /** A binding configuration module (`--bindings`), absolute; absent means the default local platform. */
  readonly bindingsModule?: string;
}

/** The composed binding of one development generation. */
export interface DevBinding {
  readonly definition: BindingsDefinition;
  /** The composed binding; the runtime starts and stops it. */
  readonly binding: RuntimeBinding;
  /**
   * The local environment operations and inspection act on, built from the
   * local providers' opened state once the runtime started; operations that
   * need local state fail clearly when no local provider is selected.
   */
  readonly local: () => LocalEnvironment;
}

/**
 * Creates the binding a development generation runs with: the default local
 * platform on the state directory, or the configuration of a bindings module,
 * resolved, validated against the runtime's handlers and composed. Every
 * problem is reported before anything starts.
 *
 * @param app - The application's default export.
 * @param runtime - Creates the runtime for a binding, so validation sees its handlers.
 * @param options - State directory, root, signed URL base and bindings module.
 * @returns The definition, composed binding, runtime and local environment access.
 * @throws {HolqaError} `HOLQA_BINDING_CONFIG_INVALID` for a module without a configuration of this application, or the configuration's problems.
 */
export async function createDevBinding<Created extends Runtime>(app: unknown, runtime: (binding: RuntimeBinding) => Created, options: DevBindingOptions): Promise<DevBinding & { readonly runtime: Created }> {
  const descriptor = getAppDescriptor(app);
  if (descriptor === undefined)
    throw new HolqaError(createDiagnostic({ code: diagnosticCodes.appInvalid, severity: "error", message: "The application module's default export is not a Holqa application." }));
  let definition: BindingsDefinition;
  if (options.bindingsModule === undefined) {
    const local = localEnvironment({ directory: options.stateDir, root: options.root, storage: { signedUrlBase: options.signedUrlBase }, telemetry: false });
    definition = defineBindings(app as BindableApp, { name: "local", defaults: local.platform() } as never);
  } else {
    const exported = (await import(pathToFileURL(options.bindingsModule).href) as { readonly default?: unknown }).default;
    if (!isBindingsDefinition(exported) || exported.app !== descriptor)
      throw new HolqaError(createDiagnostic({ code: diagnosticCodes.bindingConfigInvalid, severity: "error", message: `The bindings module "${options.bindingsModule}" does not export a binding configuration of the application "${descriptor.name}" as its default export.`, hint: "Export default defineBindings(app, { ... }), importing app from the application's infra.ts." }));
    definition = exported;
  }
  const resolved = resolveBindings(definition);
  if (resolved.diagnostics.some(diagnostic => diagnostic.severity === "error"))
    throw new HolqaError(resolved.diagnostics);
  const binding = createBinding(resolved);
  const created = runtime(binding);
  const problems: readonly Diagnostic[] = validateBindings(resolved, { handlers: created.handlers });
  if (problems.some(diagnostic => diagnostic.severity === "error"))
    throw new HolqaError(problems);
  /**
   * Builds the local environment view from the opened local state.
   *
   * @returns The view; its local-only parts fail when no local provider is open.
   */
  const local = (): LocalEnvironment => {
    const state = resolved.providers.map(localStateOf).find((candidate): candidate is OpenedLocalState => candidate !== undefined);
    if (state !== undefined)
      return Object.freeze({ binding, clock: state.clock, queues: state.queues, storage: state.storage, scheduler: state.scheduler, settle: state.settle, close: () => {} });
    /**
     * Fails an operation that needs local state.
     *
     * @throws {HolqaError} `HOLQA_LOCAL_OPERATION_FAILED`.
     */
    const unavailable = (): never => {
      throw new HolqaError(createDiagnostic({ code: diagnosticCodes.localOperationFailed, severity: "error", message: `The binding configuration "${definition.name}" selects no local provider, so local state cannot be inspected or changed.`, hint: "Use a local provider for the resources you want to operate on during development." }));
    };
    const missing = new Proxy({}, { get: unavailable }) as never;
    // Signed URL serving asks whether a request is addressed to local storage; without it, none is.
    const storage = new Proxy({}, { get: (_target, property) => property === "handles" ? () => false : unavailable() }) as never;
    return Object.freeze({ binding, clock: systemClock, queues: missing, storage, scheduler: missing, settle: async () => {}, close: () => {} });
  };
  return { definition, binding, runtime: created, local };
}