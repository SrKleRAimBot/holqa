import type {
  Diagnostic,
  HandlerDefinition,
  JsonObject,
  JsonValue
} from "@holqa/core";

import {
  isAbsolute,
  join,
  resolve
} from "node:path";
import { pathToFileURL } from "node:url";

import {
  createDiagnostic,
  diagnosticCodes,
  failWith,
  getAppDescriptor,
  getHandlerDescriptor,
  HolqaError
} from "@holqa/core";

/** Settings of {@link loadCompiledApplication}. */
export interface LoadCompiledApplicationOptions {
  /** The application root: the directory of the application module (conventionally `infra.ts`). */
  readonly root: string;
  /** The `holqa build --manifest` output directory, relative to `root` or absolute. Default `.holqa/build`. */
  readonly buildDir?: string;
}

/** A compiled application, ready for `createRuntime`. */
export interface CompiledApplication {
  /** The application: the default export of its module. */
  readonly app: unknown;
  /** Every handler registration the entry point map names, in manifest order. */
  readonly handlers: readonly unknown[];
  /** The `sha256:` fingerprint of the manifest the build was produced with. */
  readonly manifestFingerprint: string;
  /** Where each handler is implemented, as `<module>#<export>` relative to the root, by handler identifier. */
  readonly handlerSources: Readonly<Record<string, string>>;
}

/** The fields of the entry point map the loader needs. */
interface EntrypointEntry {
  readonly id: string;
  readonly module: string;
  readonly export: string;
}

/** A module's exports, with the default export named explicitly. */
interface ModuleExports {
  readonly default?: unknown;
  readonly [name: string]: unknown;
}

/** The fields of a manifest handler the loader compares. */
interface ManifestHandlerEntry {
  readonly id: string;
  readonly trigger: JsonValue;
}

/**
 * Loads an application compiled by `holqa build --manifest`: reads
 * `manifest.json` and `entrypoints.json`, checks that the entry point map
 * belongs to the manifest (by fingerprint), imports the application module
 * and every handler module it names, and checks that the loaded code still
 * matches the manifest: the same application name, resources (with their
 * settings and requirements), configuration entries, handler exports and
 * triggers. A mismatch means the source changed after the build.
 *
 * Trust: this imports and evaluates the application's own modules in the
 * current process, with its permissions. Only load build output you trust.
 * Schema changes, and handler modules added after the build, are not
 * detected; rebuild after changing either.
 *
 * @param options - The application root and build directory.
 * @returns The application and its handlers.
 * @throws {HolqaError} `HOLQA_APP_NOT_FOUND` without build output, `HOLQA_MANIFEST_INVALID` for malformed output,
 * `HOLQA_BUILD_STALE` when the output does not match the code, `HOLQA_MODULE_EVALUATION_FAILED` when a module throws
 * while loading, and `HOLQA_APP_INVALID` when the application module's default export is not an application.
 */
export async function loadCompiledApplication(options: LoadCompiledApplicationOptions): Promise<CompiledApplication> {
  const root = resolve(options.root);
  const buildDir = resolve(root, options.buildDir ?? join(".holqa", "build"));
  const manifestText = await readBuildFile(join(buildDir, "manifest.json"));
  const entrypointsText = await readBuildFile(join(buildDir, "entrypoints.json"));
  const manifest = parseBuildFile(manifestText, "manifest.json");
  const entrypoints = parseBuildFile(entrypointsText, "entrypoints.json");
  const { appModule, entries, fingerprint } = readEntrypoints(entrypoints);
  const { applicationName, handlers: manifestHandlers, resources: manifestResources, config: manifestConfig } = readManifest(manifest);

  const actual = await fingerprintText(manifestText.endsWith("\n") ? manifestText.slice(0, -1) : manifestText);
  if (actual !== fingerprint)
    stale(`entrypoints.json belongs to manifest ${fingerprint}, but manifest.json is ${actual}.`);

  const appExports = await importModule(root, appModule);
  const app = getAppDescriptor(appExports.default);
  if (app === undefined)
    failWith(diagnosticCodes.appInvalid, `The default export of ${appModule} is not a Holqa application this version can run.`);
  if (app.name !== applicationName)
    stale(`The application is named "${app.name}", but the manifest describes "${applicationName}".`);
  const declared = app.resources.map(resource => `${resource.kind} ${resource.id}`).sort();
  const compiled = [...manifestResources.keys()].sort();
  if (JSON.stringify(declared) !== JSON.stringify(compiled))
    stale(`The application declares the resources [${declared.join(", ")}], but the manifest lists [${compiled.join(", ")}].`);
  for (const resource of app.resources) {
    const recorded = manifestResources.get(`${resource.kind} ${resource.id}`)!;
    if (!sameJson(resource.config as JsonValue, recorded.config) || !sameJson(resource.requirements as JsonValue, recorded.requirements))
      stale(`The settings or requirements of ${resource.kind} "${resource.id}" changed since the build.`);
  }
  const configEntries = app.config.map(entry => `${entry.sensitive ? "secret" : "variable"} ${entry.name}`).sort();
  if (JSON.stringify(configEntries) !== JSON.stringify([...manifestConfig].sort()))
    stale(`The application declares the configuration [${configEntries.join(", ")}], but the manifest lists [${[...manifestConfig].sort().join(", ")}].`);

  const modules = new Map<string, ModuleExports>();
  const handlers: unknown[] = [];
  const handlerSources: Record<string, string> = {};
  const problems: Diagnostic[] = [];
  for (const entry of entries) {
    const exports = modules.get(entry.module) ?? await importModule(root, entry.module);
    modules.set(entry.module, exports);
    const registration = exports[entry.export];
    const descriptor = getHandlerDescriptor(registration);
    const expected = manifestHandlers.get(entry.id);
    if (descriptor === undefined || descriptor.definition.id !== entry.id) {
      problems.push(staleDiagnostic(`${entry.module} no longer exports the handler "${entry.id}" as "${entry.export}".`));
    } else if (expected === undefined) {
      problems.push(staleDiagnostic(`The handler "${entry.id}" is not in the manifest.`));
    } else if (!sameJson(normalizedTrigger(descriptor.definition), expected.trigger)) {
      problems.push(staleDiagnostic(`The trigger of handler "${entry.id}" changed since the build.`));
    } else {
      handlers.push(registration);
      handlerSources[entry.id] = `${entry.module}#${entry.export}`;
    }
  }
  if (entries.length !== manifestHandlers.size)
    problems.push(staleDiagnostic(`The manifest lists ${manifestHandlers.size} handlers, but the entry point map names ${entries.length}.`));
  if (problems.length > 0)
    throw new HolqaError(problems);
  return Object.freeze({ app: appExports.default, handlers: Object.freeze(handlers), manifestFingerprint: fingerprint, handlerSources: Object.freeze(handlerSources) });
}

/**
 * Reads one build output file.
 *
 * @param path - The absolute path.
 * @returns The file's text.
 * @throws {HolqaError} `HOLQA_APP_NOT_FOUND` when the file does not exist.
 */
async function readBuildFile(path: string): Promise<string> {
  const file = Bun.file(path);
  if (!await file.exists())
    failWith(diagnosticCodes.appNotFound, `No build output at ${path}.`, "Run `holqa build --manifest` for the application first.");
  return file.text();
}

/**
 * Parses one build output file as JSON.
 *
 * @param text - The contents of the file.
 * @param name - The file name, for messages.
 * @returns The parsed JSON, not yet checked for shape.
 * @throws {HolqaError} `HOLQA_MANIFEST_INVALID` for malformed JSON.
 */
function parseBuildFile(text: string, name: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return failWith(diagnosticCodes.manifestInvalid, `${name} is not valid JSON.`, "Rebuild with `holqa build --manifest`.");
  }
}

/**
 * Reads the parts of the entry point map the loader needs, checking their shape.
 *
 * @param value - The parsed `entrypoints.json`.
 * @returns The application module, the handler entries and the manifest fingerprint.
 * @throws {HolqaError} `HOLQA_MANIFEST_INVALID` when the map is malformed or a module path leaves the root.
 */
function readEntrypoints(value: unknown): { readonly appModule: string; readonly entries: readonly EntrypointEntry[]; readonly fingerprint: string } {
  const map = value as { readonly format?: unknown; readonly manifest?: unknown; readonly application?: { readonly module?: unknown }; readonly handlers?: unknown };
  if (typeof map !== "object" || map === null || map.format !== "holqa.entrypoints/1" || typeof map.manifest !== "string" || typeof map.application?.module !== "string" || !Array.isArray(map.handlers))
    failWith(diagnosticCodes.manifestInvalid, "entrypoints.json is not a holqa.entrypoints/1 map.", "Rebuild with `holqa build --manifest`.");
  const entries = (map.handlers as readonly unknown[]).map((entry): EntrypointEntry => {
    const candidate = entry as Partial<Record<keyof EntrypointEntry, unknown>>;
    if (typeof candidate !== "object" || candidate === null || typeof candidate.id !== "string" || typeof candidate.export !== "string" || !isPortablePath(candidate.module))
      failWith(diagnosticCodes.manifestInvalid, "entrypoints.json has a malformed handler entry.");
    return { id: candidate.id, module: candidate.module, export: candidate.export };
  });
  if (!isPortablePath(map.application.module))
    failWith(diagnosticCodes.manifestInvalid, "entrypoints.json names an application module outside the application root.");
  return { appModule: map.application.module, entries, fingerprint: map.manifest };
}

/** The fields of a manifest resource the loader compares. */
interface ManifestResourceEntry {
  readonly config: JsonValue;
  readonly requirements: JsonValue;
}

/**
 * Reads the parts of the manifest the loader compares, checking their shape.
 *
 * @param value - The parsed `manifest.json`.
 * @returns The application name, the handlers by identifier, the resources by `<kind> <id>`, and the configuration entries as `<kind> <name>`.
 * @throws {HolqaError} `HOLQA_MANIFEST_INVALID` when the manifest is malformed, or `HOLQA_MANIFEST_VERSION_UNSUPPORTED` for another version.
 */
function readManifest(value: unknown): { readonly applicationName: string; readonly handlers: ReadonlyMap<string, ManifestHandlerEntry>; readonly resources: ReadonlyMap<string, ManifestResourceEntry>; readonly config: readonly string[] } {
  const manifest = value as { readonly manifestVersion?: unknown; readonly application?: { readonly name?: unknown }; readonly handlers?: unknown; readonly resources?: unknown; readonly config?: unknown };
  if (typeof manifest !== "object" || manifest === null)
    failWith(diagnosticCodes.manifestInvalid, "manifest.json is not a manifest.");
  if (manifest.manifestVersion !== 1)
    failWith(diagnosticCodes.manifestVersionUnsupported, `manifest.json has manifest version ${JSON.stringify(manifest.manifestVersion)}; this runtime reads version 1.`);
  if (typeof manifest.application?.name !== "string" || !Array.isArray(manifest.handlers) || !Array.isArray(manifest.resources) || !Array.isArray(manifest.config))
    failWith(diagnosticCodes.manifestInvalid, "manifest.json is missing its application, handlers, resources or configuration.");
  const handlers = new Map<string, ManifestHandlerEntry>();
  for (const handler of manifest.handlers as readonly unknown[]) {
    const candidate = handler as { readonly id?: unknown; readonly trigger?: unknown } | null;
    if (typeof candidate !== "object" || candidate === null || typeof candidate.id !== "string" || typeof candidate.trigger !== "object" || candidate.trigger === null)
      failWith(diagnosticCodes.manifestInvalid, "manifest.json has a malformed handler.");
    handlers.set(candidate.id, { id: candidate.id, trigger: candidate.trigger as JsonValue });
  }
  const resources = new Map<string, ManifestResourceEntry>();
  for (const resource of manifest.resources as readonly unknown[]) {
    const candidate = resource as { readonly id?: unknown; readonly kind?: unknown; readonly config?: unknown; readonly requirements?: unknown } | null;
    if (typeof candidate !== "object" || candidate === null || typeof candidate.id !== "string" || typeof candidate.kind !== "string")
      failWith(diagnosticCodes.manifestInvalid, "manifest.json has a malformed resource.");
    resources.set(`${candidate.kind} ${candidate.id}`, { config: (candidate.config ?? {}) as JsonValue, requirements: (candidate.requirements ?? {}) as JsonValue });
  }
  const config = (manifest.config as readonly unknown[]).map((entry) => {
    const candidate = entry as { readonly name?: unknown; readonly kind?: unknown } | null;
    if (typeof candidate !== "object" || candidate === null || typeof candidate.name !== "string" || typeof candidate.kind !== "string")
      failWith(diagnosticCodes.manifestInvalid, "manifest.json has a malformed configuration entry.");
    return `${candidate.kind} ${candidate.name}`;
  });
  return { applicationName: manifest.application.name, handlers, resources, config };
}

/**
 * Imports one application module.
 *
 * @param root - The application root.
 * @param path - The module path relative to the root.
 * @returns The module's exports.
 * @throws {HolqaError} `HOLQA_MODULE_EVALUATION_FAILED` when importing throws.
 */
async function importModule(root: string, path: string): Promise<ModuleExports> {
  try {
    return await import(pathToFileURL(join(root, path)).href) as ModuleExports;
  } catch (error) {
    throw new HolqaError(createDiagnostic({
      code: diagnosticCodes.moduleEvaluationFailed,
      severity: "error",
      message: `Loading ${path} failed: ${error instanceof Error ? error.message : String(error)}`,
      location: { file: path }
    }), { cause: error });
  }
}

/**
 * Reports whether a path from build output is relative and stays inside the root.
 *
 * @param path - The candidate path.
 * @returns `true` for a non-empty relative path without `..` segments.
 */
function isPortablePath(path: unknown): path is string {
  return typeof path === "string" && path !== "" && !isAbsolute(path) && !path.split(/[/\\]/).includes("..");
}

/**
 * The trigger as the compiler records it: kind, resource reference and options.
 *
 * @param definition - A loaded handler definition.
 * @returns The trigger as JSON.
 */
function normalizedTrigger(definition: HandlerDefinition): JsonValue {
  const { kind, resource, options } = definition.trigger;
  return { kind, resource: { kind: resource.kind, id: resource.id }, options: options as JsonValue };
}

/**
 * Compares two JSON values structurally, ignoring object key order.
 *
 * @param left - A JSON value.
 * @param right - Another JSON value.
 * @returns `true` when both hold the same data.
 */
function sameJson(left: JsonValue, right: JsonValue): boolean {
  if (typeof left !== "object" || left === null || typeof right !== "object" || right === null)
    return left === right;
  if (Array.isArray(left) || Array.isArray(right))
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((entry, index) => sameJson(entry, right[index]!));
  const leftObject = left as JsonObject;
  const rightObject = right as JsonObject;
  const leftKeys = Object.keys(leftObject).sort();
  const rightKeys = Object.keys(rightObject).sort();
  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index] && sameJson(leftObject[key]!, rightObject[key]!));
}

/**
 * Computes the fingerprint the compiler records for a manifest text.
 *
 * @param text - The canonical manifest text without its trailing newline.
 * @returns `sha256:` followed by 64 hex digits.
 */
async function fingerprintText(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return `sha256:${[...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Builds a `HOLQA_BUILD_STALE` diagnostic.
 *
 * @param message - What no longer matches.
 * @returns An error diagnostic with a hint to rebuild.
 */
function staleDiagnostic(message: string): Diagnostic {
  return createDiagnostic({ code: diagnosticCodes.buildStale, severity: "error", message, hint: "Rebuild with `holqa build --manifest`." });
}

/**
 * Throws a `HOLQA_BUILD_STALE` error.
 *
 * @param message - What no longer matches.
 * @throws {HolqaError} Always.
 */
function stale(message: string): never {
  throw new HolqaError(staleDiagnostic(message));
}