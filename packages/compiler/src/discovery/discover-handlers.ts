import type {
  Diagnostic,
  HandlerDescriptor
} from "@holqa/core";

import {
  createDiagnostic,
  descriptorKey,
  descriptorProtocol,
  diagnosticCodes,
  getHandlerDescriptor
} from "@holqa/core";

import {
  compareCodeUnits,
  portableModulePath
} from "@/discovery/module-path";

/** A module that a host has already evaluated. */
export interface EvaluatedModule {
  /** Path relative to the application root. `\` separators and a leading `./` are accepted and normalized. */
  readonly path: string;
  /** The module namespace: every export by name, including `default`. */
  readonly exports: Readonly<Record<string, unknown>>;
}

/** A handler registration found among a module's exports. */
export interface DiscoveredHandler {
  readonly descriptor: HandlerDescriptor;
  /** The portable path of the module the handler is attributed to. */
  readonly module: string;
  /** Every export name under which that module exposes the handler, sorted. */
  readonly exports: readonly string[];
}

/** The handlers found in a set of modules, and the problems found while reading them. */
export interface HandlerDiscoveryResult {
  /** Handlers ordered by identifier, then module path. */
  readonly handlers: readonly DiscoveredHandler[];
  readonly diagnostics: readonly Diagnostic[];
}

/**
 * Finds every handler registration exported by evaluated modules.
 *
 * A handler is identified by its descriptor, not by where it is exported: the
 * same registration exported as `default` and by name, or re-exported by
 * another module, counts once and is attributed to the first module in path
 * order. Two different registrations that share an identifier are both
 * returned, so the caller can report the duplicate.
 *
 * An export that carries a Holqa descriptor this version cannot read is an
 * error rather than a silent omission, because the handler would otherwise
 * vanish from the manifest.
 *
 * @param modules - Evaluated modules, in any order.
 * @returns The handlers and diagnostics, independent of the input order.
 */
export function discoverHandlers(modules: readonly EvaluatedModule[]): HandlerDiscoveryResult {
  const diagnostics: Diagnostic[] = [];
  const portable: Array<{ readonly path: string; readonly exports: Readonly<Record<string, unknown>> }> = [];
  for (const module of modules) {
    const path = portableModulePath(module.path);
    if (path === undefined) {
      diagnostics.push(createDiagnostic({
        code: diagnosticCodes.declarationInvalid,
        severity: "error",
        message: `The module path "${module.path}" is not relative to the application root.`,
        hint: "Hosts must pass root-relative paths so that output never depends on the machine."
      }));
      continue;
    }
    portable.push({ path, exports: module.exports });
  }
  portable.sort((left, right) => compareCodeUnits(left.path, right.path));

  const found = new Map<HandlerDescriptor, { readonly module: string; readonly exports: string[] }>();
  for (const module of portable) {
    for (const name of Object.keys(module.exports).sort(compareCodeUnits)) {
      const value = module.exports[name];
      const descriptor = getHandlerDescriptor(value);
      if (descriptor === undefined) {
        if (carriesDescriptor(value) && !isOtherDescriptorType(value[descriptorKey])) {
          diagnostics.push(createDiagnostic({
            code: diagnosticCodes.declarationInvalid,
            severity: "error",
            message: `The export "${name}" carries a Holqa descriptor that this compiler cannot read (another protocol version, an unknown trigger kind, or a malformed registration).`,
            location: { file: module.path },
            hint: "Use one version of @holqa/sdk and @holqa/core throughout the application."
          }));
        }
        continue;
      }
      const existing = found.get(descriptor);
      if (existing === undefined)
        found.set(descriptor, { module: module.path, exports: [name] });
      else if (existing.module === module.path)
        existing.exports.push(name);
    }
  }

  const handlers = [...found].map(([descriptor, { module, exports }]) => ({ descriptor, module, exports })).sort((left, right) => compareCodeUnits(left.descriptor.definition.id, right.descriptor.definition.id) || compareCodeUnits(left.module, right.module));
  return { handlers, diagnostics };
}

/**
 * Reports whether a value carries something under the descriptor key.
 *
 * @param value - Any export.
 * @returns `true` for objects and functions with a `~holqa` property.
 */
function carriesDescriptor(value: unknown): value is { readonly [descriptorKey]: unknown } {
  return (typeof value === "object" || typeof value === "function") && value !== null && descriptorKey in value;
}

/**
 * Reports whether a descriptor is a readable descriptor of a type other than
 * a handler, such as an application or a resource handle that a handler
 * module re-exports. Those are expected and are not handler problems.
 *
 * @param descriptor - The value an export carries under the descriptor key.
 * @returns `true` when the descriptor declares the current protocol and a non-handler type.
 */
function isOtherDescriptorType(descriptor: unknown): boolean {
  return typeof descriptor === "object" && descriptor !== null
    && "protocol" in descriptor && descriptor.protocol === descriptorProtocol
    && "type" in descriptor && descriptor.type !== "handler";
}