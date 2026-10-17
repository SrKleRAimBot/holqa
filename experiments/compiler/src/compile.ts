import type { DiagnosticLocation } from "@holqa/core";
import type {
  ExperimentCode,
  HandlerDescriptor,
  SchemaAdapter,
  SchemaSide,
  StandardSchemaV1
} from "@holqa/experiment-model";

import type { CompilerDiagnostic } from "@/diagnostics";
import type {
  Manifest,
  ManifestConfig,
  ManifestHandler,
  ManifestResource,
  ManifestSchema,
  ManifestSchemaUse
} from "@/manifest";

import { parseResourceId } from "@holqa/core";
import {
  descriptorKey,
  experimentCodes,
  experimentDiagnostic,
  getAppDescriptor,
  getHandlerDescriptor
} from "@holqa/experiment-model";

import { sortDiagnostics } from "@/diagnostics";
import {
  joinRoutePath,
  routeShape
} from "@/graph/routes";
import { manifestVersion } from "@/manifest";
import { SchemaTable } from "@/schemas/schema-table";

/** A handler module that a host has already evaluated. */
export interface EvaluatedModule {
  /** Path relative to the application root. `\` separators are accepted and normalized to `/`. */
  readonly path: string;
  readonly exports: Readonly<Record<string, unknown>>;
}

/** The input of {@link compileApp}. */
export interface CompileInput {
  /** The default export of `infra.ts`. */
  readonly app: unknown;
  /** Evaluated handler modules, in any order. */
  readonly modules: readonly EvaluatedModule[];
  readonly adapters: readonly SchemaAdapter[];
  /** Path of the application module relative to the root, for diagnostics. Defaults to `infra.ts`. */
  readonly appModule?: string;
}

/** The output of {@link compileApp}. */
export interface CompileResult {
  /** `true` when no diagnostic has severity `error`. */
  readonly ok: boolean;
  /** The manifest; absent only when `app` is not an application. Present but untrustworthy when `ok` is false. */
  readonly manifest: Manifest | undefined;
  /** Every problem found, in a deterministic order. */
  readonly diagnostics: readonly CompilerDiagnostic[];
}

/** The resource kind each built-in trigger kind must reference. */
const triggerResourceKinds: Readonly<Record<string, string>> = {
  "queue.message": "queue",
  "http.route": "http.api",
  "bucket.object-created": "bucket",
  "schedule.tick": "schedule"
};

/** A handler descriptor together with every place it was exported from. */
interface DiscoveredHandler {
  readonly descriptor: HandlerDescriptor;
  readonly module: string;
  readonly exports: string[];
}

/**
 * Normalizes a host-supplied module path to a portable, root-relative path.
 *
 * @param path - The path as supplied by the host.
 * @returns The normalized path, or `undefined` when it is absolute or escapes the root.
 */
function portableModulePath(path: string): string | undefined {
  const normalized = path.replaceAll("\\", "/").replace(/^(?:\.\/)+/, "");
  if (normalized.startsWith("/") || /^[a-z]:\//i.test(normalized) || normalized.split("/").includes(".."))
    return undefined;
  return normalized;
}

/**
 * Chooses which side of a schema crosses the wire for a given role: responses
 * are serialized after validation (output); everything else is sent by a
 * producer or client before validation (input).
 *
 * @param role - The schema role, for example `message`, `body` or `response.200`.
 * @returns `"output"` for response roles, `"input"` otherwise.
 */
function wireSide(role: string): SchemaSide {
  return role.startsWith("response.") ? "output" : "input";
}

/**
 * Converts every schema of a declaration, in sorted role order.
 *
 * @param table - The schema table.
 * @param schemas - Schemas by role.
 * @param subject - The owning declaration, for diagnostics.
 * @param location - Where the declaration lives, when known.
 * @returns Schema uses by role.
 */
async function convertSchemas(table: SchemaTable, schemas: Readonly<Record<string, StandardSchemaV1>>, subject: string, location?: DiagnosticLocation): Promise<Record<string, ManifestSchemaUse>> {
  const uses: Record<string, ManifestSchemaUse> = {};
  for (const role of Object.keys(schemas).sort())
    uses[role] = await table.use(schemas[role]!, `${subject} ${role}`, wireSide(role), location);
  return uses;
}

/**
 * Finds every handler export in the evaluated modules. A descriptor exported
 * more than once (for example as `default` and by name, or re-exported by
 * another module) counts once and is attributed to the first module by path.
 *
 * @param modules - The evaluated modules.
 * @param report - Receives problems found while scanning.
 * @returns The discovered handlers.
 */
function discoverHandlers(modules: readonly EvaluatedModule[], report: (code: ExperimentCode, severity: "error" | "warning", message: string, location?: DiagnosticLocation) => void): DiscoveredHandler[] {
  const portable = modules.flatMap((module) => {
    const path = portableModulePath(module.path);
    if (path === undefined) {
      report(experimentCodes.declarationInvalid, "error", `Module path "${module.path}" must be relative to the application root.`);
      return [];
    }
    return [{ path, exports: module.exports }];
  }).sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);

  const byDescriptor = new Map<HandlerDescriptor, DiscoveredHandler>();
  for (const module of portable) {
    for (const name of Object.keys(module.exports).sort()) {
      const value = module.exports[name];
      const descriptor = getHandlerDescriptor(value);
      if (descriptor === undefined) {
        // An unreadable descriptor is an error, never a silent omission: the handler would vanish from the manifest.
        if ((typeof value === "object" || typeof value === "function") && value !== null && descriptorKey in value)
          report(experimentCodes.declarationInvalid, "error", `Export "${name}" carries a Holqa descriptor with an unknown protocol version or type.`, { file: module.path });
        continue;
      }
      const existing = byDescriptor.get(descriptor);
      if (existing === undefined)
        byDescriptor.set(descriptor, { descriptor, module: module.path, exports: [name] });
      else if (existing.module === module.path)
        existing.exports.push(name);
    }
  }
  return [...byDescriptor.values()];
}

/**
 * Compiles an evaluated application into a deterministic manifest and
 * collects every problem as a diagnostic instead of stopping at the first.
 *
 * Runtime-neutral: the host evaluates `infra.ts` and the handler modules (which
 * runs user code) and passes the results in. The output depends only on the
 * descriptors, relative module paths and adapters, never on the host,
 * discovery order, the clock or absolute paths.
 *
 * @param input - The evaluated application, handler modules and schema adapters.
 * @returns The manifest and diagnostics.
 */
export async function compileApp(input: CompileInput): Promise<CompileResult> {
  const diagnostics: CompilerDiagnostic[] = [];
  const appModule = input.appModule ?? "infra.ts";

  /**
   * Appends an experiment diagnostic.
   *
   * @param code - The diagnostic code.
   * @param severity - `error` or `warning`.
   * @param message - What is wrong.
   * @param location - Where, when known.
   */
  const report = (code: ExperimentCode, severity: "error" | "warning", message: string, location?: DiagnosticLocation): void => {
    diagnostics.push(experimentDiagnostic({ code, severity, message, ...(location === undefined ? {} : { location }) }));
  };

  const app = getAppDescriptor(input.app);
  if (app === undefined) {
    report(experimentCodes.declarationInvalid, "error", "The application module's default export is not a Holqa application.", { file: appModule });
    return { ok: false, manifest: undefined, diagnostics: sortDiagnostics(diagnostics) };
  }

  const table = new SchemaTable(input.adapters, diagnostics);
  const appLocation: DiagnosticLocation = { file: appModule };

  const resourceKinds = new Map<string, string>();
  const resourceCounts = new Map<string, number>();
  const resources: ManifestResource[] = [];
  for (const resource of [...app.resources].sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0)) {
    const parsed = parseResourceId(resource.id);
    if (!parsed.ok)
      diagnostics.push({ ...parsed.error, location: appLocation });
    resourceCounts.set(resource.id, (resourceCounts.get(resource.id) ?? 0) + 1);
    resourceKinds.set(resource.id, resource.kind);
    resources.push({
      id: resource.id,
      kind: resource.kind,
      config: resource.config,
      schemas: await convertSchemas(table, resource.schemas, `${resource.kind} "${resource.id}"`, appLocation)
    });
  }
  for (const [id, count] of resourceCounts) {
    if (count > 1)
      report(experimentCodes.resourceIdDuplicate, "error", `Resource identifier "${id}" is declared ${count} times.`, appLocation);
  }

  const discovered = discoverHandlers(input.modules, report).sort((left, right) => {
    if (left.descriptor.id !== right.descriptor.id)
      return left.descriptor.id < right.descriptor.id ? -1 : 1;
    return left.module < right.module ? -1 : left.module > right.module ? 1 : 0;
  });

  const handlerModules = new Map<string, string[]>();
  const queueConsumers = new Map<string, string[]>();
  const routes = new Map<string, string[]>();
  const handlers: ManifestHandler[] = [];
  for (const { descriptor, module, exports } of discovered) {
    const location: DiagnosticLocation = { file: module };
    const parsed = parseResourceId(descriptor.id);
    if (!parsed.ok)
      diagnostics.push({ ...parsed.error, location });
    handlerModules.set(descriptor.id, [...(handlerModules.get(descriptor.id) ?? []), module]);

    const { kind, resource } = descriptor.trigger;
    const actualKind = resourceKinds.get(resource);
    const expectedKind = triggerResourceKinds[kind];
    if (actualKind === undefined)
      report(experimentCodes.resourceNotFound, "error", `Handler "${descriptor.id}" is triggered by resource "${resource}", which the application does not declare.`, location);
    else if (expectedKind === undefined)
      report(experimentCodes.declarationInvalid, "error", `Handler "${descriptor.id}" uses trigger kind "${kind}", which this compiler does not support.`, location);
    else if (expectedKind !== actualKind)
      report(experimentCodes.declarationInvalid, "error", `Handler "${descriptor.id}" uses trigger "${kind}", which requires a ${expectedKind} resource, but "${resource}" is a ${actualKind}.`, location);

    if (kind === "queue.message")
      queueConsumers.set(resource, [...(queueConsumers.get(resource) ?? []), descriptor.id]);
    if (kind === "http.route" && actualKind === "http.api") {
      const { basePath } = app.resources.find(candidate => candidate.id === resource)?.config ?? {};
      const { method, path } = descriptor.trigger;
      if (typeof method === "string" && typeof path === "string") {
        const key = `${method} ${routeShape(joinRoutePath(typeof basePath === "string" ? basePath : "", path))}`;
        routes.set(key, [...(routes.get(key) ?? []), descriptor.id]);
      }
    }

    handlers.push({
      id: descriptor.id,
      trigger: descriptor.trigger,
      config: descriptor.config,
      module,
      exports: [...exports].sort(),
      schemas: await convertSchemas(table, descriptor.schemas, `handler "${descriptor.id}"`, location)
    });
  }
  for (const [id, modules] of handlerModules) {
    if (modules.length > 1)
      report(experimentCodes.handlerIdDuplicate, "error", `Handler identifier "${id}" is registered ${modules.length} times (${modules.join(", ")}).`, { file: modules[0]! });
  }
  for (const [queueId, consumers] of queueConsumers) {
    if (consumers.length > 1)
      report(experimentCodes.queueConsumerDuplicate, "error", `Queue "${queueId}" has ${consumers.length} consumers (${consumers.join(", ")}); a queue has exactly one competing consumer.`, appLocation);
  }
  for (const [route, ids] of routes) {
    if (ids.length > 1)
      report(experimentCodes.routeAmbiguous, "error", `Routes ${ids.map(id => `"${id}"`).join(", ")} all match ${route}.`, appLocation);
  }

  const configuration: ManifestConfig[] = [];
  for (const entry of [...app.config].sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
    const schema = await table.use(entry.schema, `${entry.sensitive ? "secret" : "variable"} "${entry.name}"`, "input", appLocation);
    if (entry.sensitive && entry.defaultValue !== undefined)
      report(experimentCodes.declarationInvalid, "error", `Secret "${entry.name}" declares a default value; secrets must not have defaults, and the value is not recorded.`, appLocation);
    configuration.push({
      name: entry.name,
      sensitive: entry.sensitive,
      schema,
      ...(entry.sensitive || entry.defaultValue === undefined ? {} : { default: entry.defaultValue })
    });
  }

  const schemas: Record<string, ManifestSchema> = {};
  for (const fingerprint of [...table.entries.keys()].sort())
    schemas[fingerprint] = table.entries.get(fingerprint)!;

  const manifest: Manifest = {
    manifestVersion,
    app: { name: app.name, handlers: [...app.handlers] },
    resources,
    handlers,
    configuration,
    schemas
  };
  const sorted = sortDiagnostics(diagnostics);
  return { ok: !sorted.some(diagnostic => diagnostic.severity === "error"), manifest, diagnostics: sorted };
}