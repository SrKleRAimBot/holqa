import type {
  AppDescriptor,
  Diagnostic,
  DiagnosticLocation,
  HandlerDescriptor,
  ResourceDescriptor,
  SchemaAdapter
} from "@holqa/core";

import type {
  DiscoveredHandler,
  EvaluatedModule
} from "@/discovery/discover-handlers";
import type {
  EntrypointMap,
  HandlerEntrypoint
} from "@/manifest/entrypoints";
import type {
  Manifest,
  ManifestConfigEntry,
  ManifestHandler,
  ManifestResource,
  ManifestRuntime,
  ManifestSchemaReferences,
  ManifestTrigger
} from "@/manifest/manifest";

import {
  createDiagnostic,
  descriptorKey,
  diagnosticCodes,
  getAppDescriptor,
  isJsonValue
} from "@holqa/core";

import { holqaSchemaAdapter } from "@/analysis/holqa-schema-adapter";
import {
  normalizeResourceKind,
  normalizeTriggerKind,
  resourceSchemas,
  triggerSchemas
} from "@/analysis/kinds";
import {
  joinRoutePath,
  routeShape
} from "@/analysis/routes";
import { SchemaTable } from "@/analysis/schema-table";
import { SourceLocator } from "@/analysis/source-locator";
import {
  hasErrors,
  sortDiagnostics
} from "@/diagnostics/sort-diagnostics";
import { discoverHandlers } from "@/discovery/discover-handlers";
import {
  compareCodeUnits,
  portableModulePath
} from "@/discovery/module-path";
import { entrypointsFormat } from "@/manifest/entrypoints";
import {
  manifestRuntimes,
  manifestVersion
} from "@/manifest/manifest";
import { fingerprintManifest } from "@/manifest/serialize-manifest";

/** Configuration entry names that map safely onto environment variable names. */
const configNamePattern = /^[A-Z_]\w*$/i;

/** What {@link compileApplication} compiles. */
export interface CompileApplicationInput {
  /** The default export of the application module, as evaluated by the host. */
  readonly app: unknown;
  /** The application module's path relative to the application root, for example `infra.ts`. */
  readonly appModule: string;
  /** The evaluated handler modules, in any order. */
  readonly modules: readonly EvaluatedModule[];
  /** The execution runtime the build targets. */
  readonly runtime: ManifestRuntime;
  /** Schema-library adapters, matched by Standard Schema vendor. */
  readonly adapters?: readonly SchemaAdapter[];
  /**
   * Optional source texts keyed by root-relative path. Used only to add line
   * and column numbers to diagnostics; they never change the manifest.
   */
  readonly sources?: Readonly<Record<string, string>>;
}

/** A successful compilation: no diagnostic is an error. */
export interface CompileApplicationSuccess {
  readonly ok: true;
  readonly manifest: Manifest;
  /** Build metadata locating each handler's module, tied to `manifest` by its fingerprint. */
  readonly entrypoints: EntrypointMap;
  /** Warnings and information, sorted. */
  readonly diagnostics: readonly Diagnostic[];
}

/** A failed compilation: at least one diagnostic is an error, and no manifest is produced. */
export interface CompileApplicationFailure {
  readonly ok: false;
  /** Every problem found, sorted. */
  readonly diagnostics: readonly Diagnostic[];
}

/** The outcome of {@link compileApplication}. */
export type CompileApplicationResult = CompileApplicationSuccess | CompileApplicationFailure;

/** A handler under analysis with the location diagnostics point at. */
interface HandlerUnderAnalysis {
  readonly discovered: DiscoveredHandler;
  readonly location: DiagnosticLocation;
}

/**
 * Compiles an evaluated application into its manifest and entry point map,
 * collecting every problem instead of stopping at the first.
 *
 * Runtime-neutral and deterministic: the host evaluates the application module
 * and the handler modules (which runs user code) and passes the results in.
 * The output depends only on the descriptors, the root-relative module paths,
 * the runtime and the adapters; never on discovery order, absolute paths, the
 * clock or the environment. Identity comes from declared `id`s: TypeScript
 * variable names, resource aliases, export names and file names never appear
 * in the manifest.
 *
 * Checks performed: application shape; resource identifiers are unique;
 * resource settings, trigger options and schema roles are well formed and
 * contain no unknown settings; handler identifiers are unique; every trigger
 * references a declared resource of the right kind; a queue consumer uses the
 * queue's message contract; a queue has at most one consumer; HTTP routes do
 * not conflict; configuration names are valid and unique, secrets have no
 * default and variable defaults are JSON; every schema has a portable wire form.
 *
 * @param input - The evaluated application, handler modules, runtime and adapters.
 * @returns The manifest, entry points and warnings; or every diagnostic when compilation fails.
 *
 * @example
 * ```ts
 * const result = await compileApplication({ app, appModule: "infra.ts", modules, runtime: "bun", adapters: [zodAdapter] });
 * if (result.ok)
 *   await write("manifest.json", serializeManifest(result.manifest));
 * ```
 */
export async function compileApplication(input: CompileApplicationInput): Promise<CompileApplicationResult> {
  const diagnostics: Diagnostic[] = [];
  /**
   * Records a diagnostic.
   *
   * @param diagnostic - A problem found during compilation.
   */
  const report = (diagnostic: Diagnostic): void => {
    diagnostics.push(diagnostic);
  };
  /**
   * Builds the failure result from every diagnostic recorded so far.
   *
   * @returns The failure with sorted diagnostics.
   */
  const fail = (): CompileApplicationFailure => ({ ok: false, diagnostics: sortDiagnostics(diagnostics) });

  const appModule = portableModulePath(input.appModule);
  if (appModule === undefined) {
    report(createDiagnostic({ code: diagnosticCodes.declarationInvalid, severity: "error", message: `The application module path "${input.appModule}" is not relative to the application root.` }));
    return fail();
  }
  if (!(manifestRuntimes as readonly string[]).includes(input.runtime)) {
    report(createDiagnostic({ code: diagnosticCodes.declarationInvalid, severity: "error", message: `The runtime "${String(input.runtime)}" is not supported. Supported: ${manifestRuntimes.join(", ")}.` }));
    return fail();
  }
  const app = getAppDescriptor(input.app);
  if (app === undefined) {
    report(invalidApp(input.app, appModule));
    return fail();
  }

  const locator = new SourceLocator(input.sources ?? {}, appModule);
  const table = new SchemaTable([...input.adapters ?? [], holqaSchemaAdapter], report);
  const capabilities = new Set<string>();

  if (app.description !== undefined && typeof app.description !== "string")
    report(declarationInvalid(`Application "${app.name}": "description" must be a string.`, locator.locate(app.name, appModule)));
  const exclude: unknown = app.handlers.exclude;
  if (exclude !== undefined && !Array.isArray(exclude))
    report(declarationInvalid(`Application "${app.name}": "handlers.exclude" must be a list of patterns.`, { file: appModule }));
  const patterns: readonly unknown[] = [...app.handlers.include, ...Array.isArray(exclude) ? exclude as readonly unknown[] : []];
  for (const pattern of patterns) {
    if (typeof pattern !== "string" || portableModulePath(pattern.replaceAll("*", "x")) === undefined)
      report(declarationInvalid(`Application "${app.name}": the handler pattern ${JSON.stringify(pattern)} must be a non-empty path relative to the application and must not contain "..".`, { file: appModule }));
  }

  const { resources, resourcesById } = await analyzeResources(app, table, locator, appModule, capabilities, report);
  const discovery = discoverHandlers(input.modules);
  diagnostics.push(...discovery.diagnostics);
  const handlers = await analyzeHandlers(discovery.handlers, resourcesById, table, locator, capabilities, report);
  const config = await analyzeConfig(app, table, locator, appModule, report);

  if (hasErrors(diagnostics))
    return fail();

  const manifest: Manifest = {
    manifestVersion,
    application: { name: app.name, ...(app.description === undefined ? {} : { description: app.description }) },
    runtime: input.runtime,
    resources,
    handlers: handlers.map(handler => handler.manifest),
    config,
    requiredCapabilities: [...capabilities].sort(compareCodeUnits),
    schemas: table.table()
  };
  const entrypoints: EntrypointMap = {
    format: entrypointsFormat,
    manifest: await fingerprintManifest(manifest),
    application: {
      module: appModule,
      handlers: { include: [...app.handlers.include], exclude: Array.isArray(exclude) ? [...exclude as readonly string[]] : [] }
    },
    handlers: handlers.map(handler => handler.entrypoint)
  };
  return { ok: true, manifest, entrypoints, diagnostics: sortDiagnostics(diagnostics) };
}

/**
 * Explains why the application module's default export is not an application.
 *
 * @param value - The default export.
 * @param appModule - The application module path.
 * @returns A `HOLQA_APP_INVALID` diagnostic.
 */
function invalidApp(value: unknown, appModule: string): Diagnostic {
  const carries = (typeof value === "object" || typeof value === "function") && value !== null && descriptorKey in value;
  return createDiagnostic({
    code: diagnosticCodes.appInvalid,
    severity: "error",
    message: carries
      ? `The default export of "${appModule}" carries a Holqa descriptor this compiler cannot read as an application (another protocol version or a malformed declaration).`
      : `The default export of "${appModule}" is not a Holqa application.`,
    location: { file: appModule },
    hint: carries ? "Use one version of @holqa/sdk and @holqa/core throughout the application." : "Export the result of defineApp(...) as the module's default export."
  });
}

/**
 * Builds a `HOLQA_DECLARATION_INVALID` error.
 *
 * @param message - What is wrong.
 * @param location - Where.
 * @returns The diagnostic.
 */
function declarationInvalid(message: string, location: DiagnosticLocation): Diagnostic {
  return createDiagnostic({ code: diagnosticCodes.declarationInvalid, severity: "error", message, location });
}

/**
 * Normalizes every declared resource and reports duplicate identifiers.
 *
 * @param app - The application descriptor.
 * @param table - Describes and collects every schema of the application.
 * @param locator - Finds identifiers in source.
 * @param appModule - The application module path, the fallback location.
 * @param capabilities - Receives the capabilities each resource requires.
 * @param report - Receives diagnostics.
 * @returns The manifest resources sorted by id, and the first descriptor declared for each id.
 */
async function analyzeResources(app: AppDescriptor, table: SchemaTable, locator: SourceLocator, appModule: string, capabilities: Set<string>, report: (diagnostic: Diagnostic) => void): Promise<{ readonly resources: ManifestResource[]; readonly resourcesById: ReadonlyMap<string, { readonly descriptor: ResourceDescriptor; readonly resource: ManifestResource }> }> {
  const byId = new Map<string, ResourceDescriptor[]>();
  for (const resource of app.resources)
    byId.set(resource.id, [...byId.get(resource.id) ?? [], resource]);

  const resources: ManifestResource[] = [];
  const resourcesById = new Map<string, { readonly descriptor: ResourceDescriptor; readonly resource: ManifestResource }>();
  for (const id of [...byId.keys()].sort(compareCodeUnits)) {
    const [descriptor, ...duplicates] = byId.get(id)!;
    const location = locator.locate(id, appModule);
    if (duplicates.length > 0) {
      report(createDiagnostic({
        code: diagnosticCodes.resourceIdDuplicate,
        severity: "error",
        message: `The resource identifier "${id}" is declared ${duplicates.length + 1} times (${[descriptor!, ...duplicates].map(resource => resource.kind).join(", ")}).`,
        location,
        hint: "Identifiers are persistent identities and must be unique within an application. Give each declaration its own id.",
        details: { id }
      }));
    }
    const resource = await analyzeResource(descriptor!, table, location, capabilities, report);
    resources.push(resource);
    resourcesById.set(id, { descriptor: descriptor!, resource });
  }
  return { resources, resourcesById };
}

/**
 * Normalizes one resource: settings, requirements, capabilities and schemas.
 *
 * @param descriptor - The untrusted resource descriptor from the application.
 * @param table - Describes and collects every schema of the application.
 * @param location - Where the resource is declared.
 * @param capabilities - Receives the capabilities the resource requires.
 * @param report - Receives diagnostics.
 * @returns The resource as recorded in the manifest.
 */
async function analyzeResource(descriptor: ResourceDescriptor, table: SchemaTable, location: DiagnosticLocation, capabilities: Set<string>, report: (diagnostic: Diagnostic) => void): Promise<ManifestResource> {
  const label = `${descriptor.kind} "${descriptor.id}"`;
  const normalized = normalizeResourceKind(descriptor.kind, descriptor.config, descriptor.requirements);
  const roles = resourceSchemas(descriptor.kind, descriptor.schemas);
  for (const problem of [...normalized.problems, ...roles.problems])
    report(declarationInvalid(`The ${label}: ${problem}`, location));
  for (const capability of normalized.capabilities)
    capabilities.add(capability);

  const schemaVersion = descriptor.kind === "queue" && "schemaVersion" in normalized.config ? normalized.config.schemaVersion : undefined;
  const schemas: Record<string, ManifestSchemaReferences[string]> = {};
  for (const { role, schema } of roles.roles) {
    const reference = await table.reference(schema, { subject: `${role} of ${label}`, role, location, ...(schemaVersion === undefined ? {} : { schemaVersion }) });
    if (reference !== undefined)
      schemas[role] = reference;
  }
  return { id: descriptor.id, kind: descriptor.kind, config: normalized.config, requirements: normalized.requirements, schemas } as ManifestResource;
}

/**
 * Validates every discovered handler against the declared resources and
 * against each other.
 *
 * @param discovered - The discovered handlers, sorted by id then module.
 * @param resourcesById - The declared resources by id.
 * @param table - Describes and collects every schema of the application.
 * @param locator - Finds identifiers in source.
 * @param capabilities - Receives the capabilities each trigger requires.
 * @param report - Receives diagnostics.
 * @returns One manifest handler and entry point per distinct identifier, sorted by id.
 */
async function analyzeHandlers(discovered: readonly DiscoveredHandler[], resourcesById: ReadonlyMap<string, { readonly descriptor: ResourceDescriptor; readonly resource: ManifestResource }>, table: SchemaTable, locator: SourceLocator, capabilities: Set<string>, report: (diagnostic: Diagnostic) => void): Promise<Array<{ readonly manifest: ManifestHandler; readonly entrypoint: HandlerEntrypoint }>> {
  const byId = new Map<string, HandlerUnderAnalysis[]>();
  for (const handler of discovered) {
    const { id } = handler.descriptor.definition;
    byId.set(id, [...byId.get(id) ?? [], { discovered: handler, location: locator.locate(id, handler.module, handler.module) }]);
  }

  const consumers = new Map<string, HandlerUnderAnalysis[]>();
  const routes = new Map<string, Array<HandlerUnderAnalysis & { readonly route: string }>>();
  const results: Array<{ readonly manifest: ManifestHandler; readonly entrypoint: HandlerEntrypoint }> = [];
  for (const id of [...byId.keys()].sort(compareCodeUnits)) {
    const [first, ...duplicates] = byId.get(id)!;
    if (duplicates.length > 0) {
      const modules = [first!, ...duplicates].map(handler => handler.discovered.module);
      for (const duplicate of duplicates) {
        report(createDiagnostic({
          code: diagnosticCodes.handlerIdDuplicate,
          severity: "error",
          message: `The handler identifier "${id}" is registered ${modules.length} times (${modules.join(", ")}).`,
          location: duplicate.location,
          hint: "Handler identifiers are persistent identities and must be unique within an application. Give each registration its own id.",
          details: { id, modules }
        }));
      }
    }
    const { descriptor, module, exports } = first!.discovered;
    const { location } = first!;
    const trigger = await analyzeTrigger(descriptor, resourcesById, table, location, report);
    for (const capability of trigger.capabilities)
      capabilities.add(capability);
    if (trigger.queue !== undefined)
      consumers.set(trigger.queue, [...consumers.get(trigger.queue) ?? [], first!]);
    if (trigger.route !== undefined)
      routes.set(trigger.route, [...routes.get(trigger.route) ?? [], { ...first!, route: trigger.route }]);
    results.push({
      manifest: { id: descriptor.definition.id, trigger: trigger.manifest, schemas: trigger.schemas },
      entrypoint: { id: descriptor.definition.id, module, export: exports.includes("default") ? "default" : exports[0]!, exports: [...exports] }
    });
  }

  for (const [queue, registered] of consumers) {
    if (registered.length < 2)
      continue;
    const ids = registered.map(handler => handler.discovered.descriptor.definition.id);
    for (const extra of registered.slice(1)) {
      report(createDiagnostic({
        code: diagnosticCodes.queueConsumerDuplicate,
        severity: "error",
        message: `The queue "${queue}" has ${registered.length} consumers (${ids.map(id => `"${id}"`).join(", ")}); a queue has exactly one competing consumer.`,
        location: extra.location,
        hint: "Keep one consumer per queue and raise its concurrency, or declare a separate queue per consumer.",
        details: { queue, handlers: ids }
      }));
    }
  }
  for (const [route, registered] of routes) {
    if (registered.length < 2)
      continue;
    const ids = registered.map(handler => handler.discovered.descriptor.definition.id);
    for (const extra of registered.slice(1)) {
      report(createDiagnostic({
        code: diagnosticCodes.routeConflict,
        severity: "error",
        message: `The routes ${ids.map(id => `"${id}"`).join(", ")} all match ${route.slice(route.indexOf(" ") + 1)}.`,
        location: extra.location,
        hint: "Two routes conflict when they have the same method and the same path once parameter names are ignored. Change the method or path of one of them.",
        details: { route: route.slice(route.indexOf(" ") + 1), handlers: ids }
      }));
    }
  }
  return results;
}

/** A handler's analyzed trigger and the keys used for graph-wide checks. */
interface AnalyzedTrigger {
  readonly manifest: ManifestTrigger;
  readonly schemas: ManifestSchemaReferences;
  readonly capabilities: readonly string[];
  /** The consumed queue's id, for the one-consumer check. */
  readonly queue?: string;
  /** `<api> <METHOD> <shape>`, for the route conflict check. */
  readonly route?: string;
}

/**
 * Validates and normalizes one handler's trigger and schemas.
 *
 * @param descriptor - The handler descriptor.
 * @param resourcesById - The declared resources by id.
 * @param table - Describes and collects every schema of the application.
 * @param location - Where the handler is registered.
 * @param report - Receives diagnostics.
 * @returns The analyzed trigger.
 */
async function analyzeTrigger(descriptor: HandlerDescriptor, resourcesById: ReadonlyMap<string, { readonly descriptor: ResourceDescriptor; readonly resource: ManifestResource }>, table: SchemaTable, location: DiagnosticLocation, report: (diagnostic: Diagnostic) => void): Promise<AnalyzedTrigger> {
  const { id, trigger } = descriptor.definition;
  const label = `handler "${id}"`;
  /**
   * Reports a `HOLQA_TRIGGER_INVALID` error for this handler.
   *
   * @param message - What is wrong with the trigger.
   * @param hint - Optional guidance for fixing it.
   */
  const triggerInvalid = (message: string, hint?: string): void => {
    report(createDiagnostic({ code: diagnosticCodes.triggerInvalid, severity: "error", message, location, ...(hint === undefined ? {} : { hint }), details: { handler: id, trigger: trigger.kind } }));
  };

  const normalized = normalizeTriggerKind(trigger.kind, trigger.options);
  const roles = triggerSchemas(trigger.kind, descriptor.schemas);
  for (const problem of [...normalized.problems, ...roles.problems])
    triggerInvalid(`The ${trigger.kind} trigger of ${label}: ${problem}`);

  const target = resourcesById.get(trigger.resource.id);
  if (target === undefined) {
    const candidates = [...resourcesById.values()].filter(entry => entry.descriptor.kind === trigger.resource.kind).map(entry => `"${entry.descriptor.id}"`);
    report(createDiagnostic({
      code: diagnosticCodes.resourceNotFound,
      severity: "error",
      message: `The ${label} is triggered by ${trigger.resource.kind} "${trigger.resource.id}", which the application does not declare.`,
      location,
      hint: candidates.length === 0
        ? `Declare the ${trigger.resource.kind} in defineApp({ resources }), or remove the handler.`
        : `Declare the ${trigger.resource.kind} in defineApp({ resources }), or register the handler on a declared ${trigger.resource.kind}: ${candidates.join(", ")}.`,
      details: { handler: id, resource: trigger.resource.id, kind: trigger.resource.kind }
    }));
  } else if (target.descriptor.kind !== trigger.resource.kind) {
    triggerInvalid(`The ${label} uses a ${trigger.kind} trigger, which requires a ${trigger.resource.kind}, but "${trigger.resource.id}" is a ${target.descriptor.kind}.`);
  }

  const schemas: Record<string, ManifestSchemaReferences[string]> = {};
  for (const { role, schema } of roles.roles) {
    const reference = await table.reference(schema, { subject: `${role} of ${label}`, role, location });
    if (reference !== undefined)
      schemas[role] = reference;
  }

  const manifest = { kind: trigger.kind, resource: { kind: trigger.resource.kind, id: trigger.resource.id }, options: normalized.options } as ManifestTrigger;
  if (target === undefined || target.descriptor.kind !== trigger.resource.kind)
    return { manifest, schemas, capabilities: normalized.capabilities };

  if (target.resource.kind === "queue") {
    const { message: declared } = target.resource.schemas;
    const { message: consumed } = schemas;
    const expected = declared?.fingerprint;
    const actual = consumed?.fingerprint;
    if (expected !== undefined && actual !== undefined && expected !== actual)
      triggerInvalid(`The ${label} consumes queue "${trigger.resource.id}" with a message contract that differs from the queue's.`, "Register the consumer on the queue handle declared in the application, so that both use the same message schema.");
    return { manifest, schemas, capabilities: normalized.capabilities, queue: trigger.resource.id };
  }
  if (target.resource.kind === "http.api" && manifest.kind === "http.route") {
    const path = joinRoutePath(target.resource.config.basePath, manifest.options.path);
    return { manifest, schemas, capabilities: normalized.capabilities, route: `${target.resource.id} ${manifest.options.method} ${routeShape(path)}` };
  }
  return { manifest, schemas, capabilities: normalized.capabilities };
}

/**
 * Validates every configuration entry and records its schema. Values are
 * never read, and a secret's default is never recorded.
 *
 * @param app - The application descriptor.
 * @param table - Describes and collects every schema of the application.
 * @param locator - Finds names in source.
 * @param appModule - The application module path, the fallback location.
 * @param report - Receives diagnostics.
 * @returns The manifest configuration entries, sorted by name.
 */
async function analyzeConfig(app: AppDescriptor, table: SchemaTable, locator: SourceLocator, appModule: string, report: (diagnostic: Diagnostic) => void): Promise<ManifestConfigEntry[]> {
  const entries: ManifestConfigEntry[] = [];
  const seen = new Set<string>();
  for (const entry of [...app.config].sort((left, right) => compareCodeUnits(left.name, right.name))) {
    const kind = entry.sensitive ? "secret" : "variable";
    const location = locator.locate(entry.name, appModule, appModule);
    if (!configNamePattern.test(entry.name))
      report(declarationInvalid(`The ${kind} "${entry.name}": names must start with a letter or "_" and contain only letters, digits and "_".`, location));
    if (seen.has(entry.name)) {
      report(declarationInvalid(`The configuration entry "${entry.name}" is declared more than once.`, location));
      continue;
    }
    seen.add(entry.name);
    const defaultValue: unknown = entry.defaultValue;
    if (entry.sensitive && defaultValue !== undefined)
      report(declarationInvalid(`The secret "${entry.name}" declares a default value. Secrets must not have defaults; the value is not recorded.`, location));
    else if (defaultValue !== undefined && !isJsonValue(defaultValue))
      report(declarationInvalid(`The default value of variable "${entry.name}" is not JSON.`, location));
    const schema = await table.reference(entry.schema, { subject: `${kind} "${entry.name}"`, role: "value", location });
    if (schema === undefined)
      continue;
    entries.push({
      name: entry.name,
      kind,
      schema,
      ...(entry.sensitive || defaultValue === undefined || !isJsonValue(defaultValue) ? {} : { default: defaultValue })
    });
  }
  return entries;
}