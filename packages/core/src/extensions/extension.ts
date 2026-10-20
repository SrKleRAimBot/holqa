import type { AppDescriptor } from "@/app/app-descriptor";
import type { Diagnostic } from "@/diagnostics/diagnostic";
import type { StandardSchemaV1 } from "@/schema/standard-schema";

import { diagnosticCodes } from "@/diagnostics/codes";
import { createDiagnostic } from "@/diagnostics/diagnostic";
import {
  failWith,
  HolqaError
} from "@/errors/holqa-error";
import { isStandardSchema } from "@/schema/standard-schema";

// Extensions let infrastructure offer functionality beyond Holqa's portable
// resource kinds (an edge cache, a feature flag client, a search index)
// without changing the kind registry. An extension is a typed, versioned
// contract identified by a namespaced id; providers implement it, binding
// configurations select an implementation, and applications declare which
// extensions they require and which they can do without.

/** A reference to one version of an extension. */
export interface ExtensionReference {
  /** The namespaced identifier, for example `example.edge-cache`. */
  readonly id: string;
  readonly version: number;
}

/**
 * A typed, versioned extension contract. Holds no implementation: it names
 * the contract and carries its API type for the compiler.
 *
 * @typeParam Api - The operations an implementation provides.
 */
export interface ExtensionDefinition<Api = unknown> extends ExtensionReference {
  readonly "type": "holqa.extension";
  /** One sentence describing the extension, for inspection. */
  readonly "description"?: string;
  /** Runtimes an implementation can run in, for example `["bun"]`. Absent means any. */
  readonly "runtimes"?: readonly string[];
  /** Other extensions every implementation needs, checked when a binding is validated. */
  readonly "dependsOn"?: readonly ExtensionReference[];
  /** The schema of an implementation's configuration; implementations validate their settings with it. */
  readonly "config"?: StandardSchemaV1;
  /** Phantom carrier of the API type; never present at run time. */
  readonly "~api"?: Api;
}

/** The API type of an extension definition. */
export type ExtensionApi<Extension> = Extension extends ExtensionDefinition<infer Api> ? Api : never;

/** An extension an application declares, required or optional. */
export interface ExtensionRequirement extends ExtensionReference {
  /** `true`: the application cannot start without it. `false`: it checks at run time and falls back without it. */
  readonly required: boolean;
}

/**
 * The extensions a runtime binding provides: their versions, known before
 * the binding starts, and their implementations, available once it has.
 */
export interface ExtensionBinding {
  /** The version of every provided extension, by identifier. */
  readonly provided: Readonly<Record<string, number>>;
  /**
   * Returns an extension's implementation.
   *
   * @throws {HolqaError} `HOLQA_RUNTIME_NOT_RUNNING` before the binding has started.
   */
  readonly resolve: (id: string) => unknown;
}

/** Settings of {@link defineExtension}. */
export interface ExtensionOptions {
  /** The namespaced identifier: at least two dot-separated lowercase segments, for example `example.edge-cache`. */
  readonly id: string;
  /** The contract version, a positive whole number; increase it when the API's meaning changes. */
  readonly version: number;
  readonly description?: string;
  readonly runtimes?: readonly string[];
  readonly dependsOn?: readonly ExtensionReference[];
  readonly config?: StandardSchemaV1;
}

/** Matches an extension identifier. */
const extensionIdPattern = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/;

/**
 * Reports problems with an extension reference.
 *
 * @param reference - The candidate, unvalidated.
 * @param label - What it is, for messages.
 * @returns One sentence per problem.
 */
export function extensionReferenceProblems(reference: unknown, label: string): string[] {
  if (typeof reference !== "object" || reference === null)
    return [`${label} must be an extension reference { id, version }.`];
  const { id, version } = reference as { readonly id?: unknown; readonly version?: unknown };
  return [
    ...typeof id === "string" && id.length <= 128 && extensionIdPattern.test(id) ? [] : [`${label} needs a namespaced "id" such as "example.edge-cache".`],
    ...typeof version === "number" && Number.isSafeInteger(version) && version >= 1 ? [] : [`${label} needs a positive whole "version".`]
  ];
}

/**
 * Defines a typed, versioned extension contract. Pure: implementations are
 * supplied by binding providers, never by the definition.
 *
 * @example
 * ```ts
 * export const edgeCache = defineExtension<{
 *   get: (key: string) => Promise<string | undefined>;
 *   set: (key: string, value: string, options?: { ttlSeconds?: number }) => Promise<void>;
 * }>({ id: "example.edge-cache", version: 1 });
 * ```
 *
 * @param options - Identifier, version, description, runtimes, dependencies and configuration schema.
 * @returns The frozen definition.
 * @throws {HolqaError} `HOLQA_EXTENSION_INVALID`, one diagnostic per problem.
 */
export function defineExtension<Api>(options: ExtensionOptions): ExtensionDefinition<Api> {
  const problems: string[] = typeof options === "object" && options !== null ? extensionReferenceProblems(options, "An extension") : ["defineExtension needs { id, version }."];
  if (typeof options === "object" && options !== null) {
    if (options.description !== undefined && typeof options.description !== "string")
      problems.push("\"description\" must be a string.");
    if (options.runtimes !== undefined && !(Array.isArray(options.runtimes) && options.runtimes.length > 0 && options.runtimes.every(runtime => typeof runtime === "string" && runtime !== "")))
      problems.push("\"runtimes\" must be a non-empty list of runtime names.");
    if (options.dependsOn !== undefined) {
      if (!Array.isArray(options.dependsOn))
        problems.push("\"dependsOn\" must be a list of extension references.");
      else
        options.dependsOn.forEach((reference, index) => problems.push(...extensionReferenceProblems(reference, `dependsOn[${index}]`)));
    }
    if (options.config !== undefined && !isStandardSchema(options.config))
      problems.push("\"config\" must be a Standard Schema.");
  }
  if (problems.length > 0)
    throw new HolqaError(problems.map(message => createDiagnostic({ code: diagnosticCodes.extensionInvalid, severity: "error", message: `defineExtension: ${message}` })));
  return Object.freeze({
    type: "holqa.extension",
    id: options.id,
    version: options.version,
    ...options.description === undefined ? {} : { description: options.description },
    ...options.runtimes === undefined ? {} : { runtimes: Object.freeze([...options.runtimes]) },
    ...options.dependsOn === undefined ? {} : { dependsOn: Object.freeze(options.dependsOn.map(reference => Object.freeze({ id: reference.id, version: reference.version }))) },
    ...options.config === undefined ? {} : { config: options.config }
  });
}

/**
 * Reports whether a value is an extension definition.
 *
 * @param value - The candidate.
 * @returns `true` for a definition created by `defineExtension` (or an equal plain object).
 */
export function isExtensionDefinition(value: unknown): value is ExtensionDefinition {
  return typeof value === "object" && value !== null && (value as { readonly type?: unknown }).type === "holqa.extension" && extensionReferenceProblems(value, "").length === 0;
}

/**
 * Compares the extensions an application declares with those a binding
 * provides: every required extension must be provided in its version, and an
 * optional one provided in another version is reported, because using it
 * would break its contract.
 *
 * @param app - The application.
 * @param provided - The provided versions by identifier, or `undefined` for a binding without extensions.
 * @param bindingName - The binding's name, for messages.
 * @returns `HOLQA_EXTENSION_MISSING` and `HOLQA_EXTENSION_INCOMPATIBLE` errors (warnings for optional extensions).
 */
export function checkExtensions(app: AppDescriptor, provided: Readonly<Record<string, number>> | undefined, bindingName: string): Diagnostic[] {
  const problems: Diagnostic[] = [];
  for (const requirement of app.extensions ?? []) {
    const version = provided?.[requirement.id];
    const severity = requirement.required ? "error" : "warning";
    if (version === undefined) {
      if (requirement.required)
        problems.push(createDiagnostic({ code: diagnosticCodes.extensionMissing, severity, message: `Binding "${bindingName}" provides no implementation of the extension "${requirement.id}", which the application "${app.name}" requires.`, hint: "Select a provider that implements it in the binding configuration's \"extensions\", or make the extension optional and handle its absence.", details: { extension: requirement.id, version: requirement.version, binding: bindingName } }));
    } else if (version !== requirement.version) {
      problems.push(createDiagnostic({ code: diagnosticCodes.extensionIncompatible, severity, message: `Binding "${bindingName}" implements version ${version} of the extension "${requirement.id}", but the application "${app.name}" uses version ${requirement.version}.`, details: { extension: requirement.id, version: requirement.version, provided: version, binding: bindingName } }));
    }
  }
  return problems;
}

/**
 * Returns an extension's implementation from the application's current
 * binding, or `undefined` when the binding provides no implementation of
 * that version. For optional extensions, whose absence the application handles.
 *
 * @param app - The application descriptor.
 * @param extension - The extension definition, compared by identifier and version.
 * @returns The implementation, or `undefined`.
 * @throws {HolqaError} `HOLQA_RUNTIME_NOT_BOUND` outside a runtime.
 */
export function findExtension<Api>(app: AppDescriptor, extension: ExtensionDefinition<Api>): Api | undefined {
  const binding = app.binding.current;
  if (binding === undefined)
    failWith(diagnosticCodes.runtimeNotBound, `The extension "${extension.id}" was used while application "${app.name}" is not bound to a runtime.`, "Use extensions inside handlers, never at module top level.");
  if (binding.extensions?.provided[extension.id] !== extension.version)
    return undefined;
  return binding.extensions.resolve(extension.id) as Api;
}

/**
 * Returns an extension's implementation from the application's current
 * binding, failing clearly when it is not provided in this version.
 *
 * @param app - The application descriptor.
 * @param extension - The extension definition, compared by identifier and version.
 * @returns The implementation.
 * @throws {HolqaError} `HOLQA_RUNTIME_NOT_BOUND` outside a runtime, `HOLQA_EXTENSION_MISSING` or `HOLQA_EXTENSION_INCOMPATIBLE`.
 */
export function requireExtension<Api>(app: AppDescriptor, extension: ExtensionDefinition<Api>): Api {
  const found = findExtension(app, extension);
  if (found !== undefined)
    return found;
  const binding = app.binding.current!;
  const version = binding.extensions?.provided[extension.id];
  if (version === undefined)
    failWith(diagnosticCodes.extensionMissing, `Binding "${binding.name}" provides no implementation of the extension "${extension.id}".`, "Declare the extension as required in defineApp so that a runtime refuses to start without it.");
  failWith(diagnosticCodes.extensionIncompatible, `Binding "${binding.name}" implements version ${version} of the extension "${extension.id}", not version ${extension.version}.`);
}