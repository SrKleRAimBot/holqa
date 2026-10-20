import type {
  BindingReport,
  ValidatedHandler
} from "@holqa/bindings";
import type {
  EvaluatedModule,
  ModuleResolver
} from "@holqa/compiler";

import type {
  Diagnostic,
  SchemaAdapter
} from "@holqa/core";

import type { AnalysisReport } from "@/analysis/report";

import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync
} from "node:fs";
import {
  dirname,
  isAbsolute,
  join,
  relative,
  sep
} from "node:path";
import { pathToFileURL } from "node:url";

import {
  inspectBindings,
  isBindingsDefinition,
  resolveBindings
} from "@holqa/bindings";
import {
  compileApplication,
  hasErrors,
  moduleEvaluationFailure,
  selectHandlerModules,
  sortDiagnostics
} from "@holqa/compiler";
import {
  createDiagnostic,
  diagnosticCodes,
  getAppDescriptor,
  getHandlerDescriptor,
  isStandardSchema
} from "@holqa/core";

import { analysisReportFormat } from "@/analysis/report";

/** What the analysis process is asked to analyze. */
export interface AnalysisRequest {
  /** The absolute path of the application root: the directory of the application module. */
  readonly root: string;
  /** The application module's file name relative to the root, conventionally `infra.ts`. */
  readonly appModule: string;
  /** The absolute path of a binding configuration module to resolve against the application, if any. */
  readonly bindingsModule?: string;
}

/** Directories never searched for handler modules or sources. */
const skippedDirectories = new Set(["node_modules"]);

/** File extensions whose text is indexed to add line numbers to diagnostics. */
const sourceExtensions = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

/** Larger files are not indexed for diagnostic locations. */
const maxIndexedSourceBytes = 512 * 1024;

/** Standard Schema vendors that can name an adapter package (`@holqa/<vendor>`). */
const adapterVendorPattern = /^[a-z][a-z0-9-]*$/;

/**
 * Evaluates an application and its handler modules and compiles them into a
 * report. This runs the application's code, in the current process; the CLI
 * calls it only inside the dedicated analysis process.
 *
 * Steps: import the application module; list the files under the root
 * (skipping `node_modules` and dot directories); select handler modules with
 * the application's patterns; import them in path order; load schema adapters
 * named `@holqa/<vendor>` that the application can resolve; compile.
 * Every problem becomes a diagnostic; no manifest is reported when any is an error.
 *
 * @param request - The application root and module.
 * @returns The analysis report, JSON data only.
 */
export async function runAnalysis(request: AnalysisRequest): Promise<AnalysisReport> {
  const diagnostics: Diagnostic[] = [];
  const appPath = join(request.root, request.appModule);
  if (!existsSync(appPath)) {
    return report(false, [createDiagnostic({
      code: diagnosticCodes.appNotFound,
      severity: "error",
      message: `The application module "${request.appModule}" does not exist.`,
      hint: "Run the command in the directory that contains infra.ts, or pass --app <path>."
    })]);
  }

  let app: unknown;
  let appExports: Record<string, unknown>;
  try {
    const { default: exported, ...others } = await import(pathToFileURL(appPath).href) as Record<string, unknown>;
    app = exported;
    appExports = others;
  } catch (error) {
    return report(false, [moduleEvaluationFailure(request.appModule, error)]);
  }
  const descriptor = getAppDescriptor(app);

  const files = listFiles(request.root);
  const modules: EvaluatedModule[] = [];
  if (descriptor !== undefined) {
    const selection = selectHandlerModules(files, { include: descriptor.handlers.include, exclude: descriptor.handlers.exclude ?? [] }, request.appModule);
    diagnostics.push(...selection.diagnostics);
    for (const path of selection.modules) {
      try {
        modules.push({ path, exports: { ...await import(pathToFileURL(join(request.root, path)).href) as Record<string, unknown> } });
      } catch (error) {
        diagnostics.push(moduleEvaluationFailure(path, error));
      }
    }
  }

  const result = await compileApplication({
    app,
    appModule: request.appModule,
    modules,
    runtime: "bun",
    adapters: await loadAdapters(request.root, schemaVendors(app, modules)),
    sources: readSources(request.root, files),
    appExports,
    resolveModule: moduleResolver(request.root)
  });
  const all = sortDiagnostics([...diagnostics, ...result.diagnostics]);
  if (!result.ok || hasErrors(all))
    return report(false, all);
  const success = { ...report(true, all), manifest: result.manifest, entrypoints: result.entrypoints, events: result.events };
  if (request.bindingsModule === undefined)
    return success;
  const bindings = await loadBindings(request.bindingsModule, app, result.manifest.handlers, request.root);
  return "report" in bindings ? { ...success, bindings: bindings.report } : report(false, sortDiagnostics([...all, bindings.diagnostic]));
}

/**
 * Imports a binding configuration module, checks that it binds the analyzed
 * application, and resolves, validates and describes it.
 *
 * @param path - The module's absolute path.
 * @param app - The analyzed application's default export.
 * @param handlers - The manifest's handlers, whose triggers must be delivered.
 * @param root - The application root, for messages.
 * @returns The binding report, or the diagnostic that prevented it.
 */
async function loadBindings(path: string, app: unknown, handlers: readonly ValidatedHandler[], root: string): Promise<{ readonly report: BindingReport } | { readonly diagnostic: Diagnostic }> {
  const display = relative(root, path).split(sep).join("/");
  let exported: unknown;
  try {
    exported = (await import(pathToFileURL(path).href) as { readonly default?: unknown }).default;
  } catch (error) {
    return { diagnostic: moduleEvaluationFailure(display, error) };
  }
  if (!isBindingsDefinition(exported))
    return { diagnostic: createDiagnostic({ code: diagnosticCodes.bindingConfigInvalid, severity: "error", message: `The module "${display}" does not export a binding configuration as its default export.`, hint: "Export default defineBindings(app, { ... }) from @holqa/bindings." }) };
  if (exported.app !== getAppDescriptor(app))
    return { diagnostic: createDiagnostic({ code: diagnosticCodes.bindingConfigInvalid, severity: "error", message: `The binding configuration "${exported.name}" in "${display}" binds the application "${exported.app.name}", not the analyzed application.`, hint: "Import the application from the same infra.ts module that is analyzed." }) };
  return { report: inspectBindings(resolveBindings(exported), { handlers }) };
}

/**
 * Creates the import resolver event analysis uses: Bun resolves a
 * specifier the way the runtime does (including `tsconfig` path aliases),
 * and only modules inside the application root, outside `node_modules`, are
 * returned, with their namespace. Modules the application already imported
 * come from Bun's module cache; importing one that is not loaded yet runs it,
 * like the rest of analysis runs application code.
 *
 * @param root - The application root.
 * @returns A resolver that returns root-relative paths and evaluated namespaces.
 */
function moduleResolver(root: string): ModuleResolver {
  return async (specifier, from) => {
    let resolved: string;
    try {
      resolved = Bun.resolveSync(specifier, join(root, dirname(from)));
    } catch {
      // A specifier Bun cannot resolve is unresolved; analysis reports what it publishes as unknown.
      return undefined;
    }
    const path = relative(root, resolved);
    if (path === "" || path.startsWith("..") || isAbsolute(path) || path.split(sep).includes("node_modules"))
      return undefined;
    const portable = path.split(sep).join("/");
    try {
      return { path: portable, exports: { ...await import(pathToFileURL(resolved).href) as Record<string, unknown> } };
    } catch (error) {
      // The module's source can still be read; only its evaluated values are
      // missing. Say so in the analysis output instead of hiding the failure.
      console.error(`holqa: event analysis could not import "${portable}" (${error instanceof Error ? error.message : String(error)}); publications through it may be reported as unknown.`);
      return { path: portable };
    }
  };
}

/**
 * Builds a report without a manifest.
 *
 * @param ok - Whether analysis succeeded.
 * @param diagnostics - Every diagnostic, sorted.
 * @returns A report in the analysis report format, without manifest or entry points.
 */
function report(ok: boolean, diagnostics: readonly Diagnostic[]): AnalysisReport {
  return { format: analysisReportFormat, ok, diagnostics };
}

/**
 * Lists every regular file under a directory as root-relative POSIX paths.
 * `node_modules` and directories whose name starts with `.` (such as `.git`
 * and the default `.holqa` build output) are skipped, and symbolic links are
 * not followed, so discovery never leaves the application root.
 *
 * @param root - The application root.
 * @returns Root-relative paths in no particular order.
 */
function listFiles(root: string): string[] {
  const files: string[] = [];
  /**
   * Adds the regular files of a directory and recurses into its eligible subdirectories.
   *
   * @param directory - An absolute directory path inside the root.
   */
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory() && !entry.name.startsWith(".") && !skippedDirectories.has(entry.name))
        visit(path);
      else if (entry.isFile())
        files.push(relative(root, path).split(sep).join("/"));
    }
  };
  visit(root);
  return files;
}

/**
 * Reads the text of source files, used only to add line and column numbers to diagnostics.
 *
 * @param root - The application root.
 * @param files - Root-relative file paths.
 * @returns Source texts keyed by root-relative path.
 */
function readSources(root: string, files: readonly string[]): Record<string, string> {
  const sources: Record<string, string> = {};
  for (const file of files) {
    if (!sourceExtensions.some(extension => file.endsWith(extension)))
      continue;
    const path = join(root, file);
    if (statSync(path).size <= maxIndexedSourceBytes)
      sources[file] = readFileSync(path, "utf8");
  }
  return sources;
}

/**
 * Collects the Standard Schema vendors used by the application's resources,
 * configuration and handlers.
 *
 * @param app - The application module's default export.
 * @param modules - The evaluated handler modules.
 * @returns The vendor names, sorted.
 */
function schemaVendors(app: unknown, modules: readonly EvaluatedModule[]): string[] {
  const vendors = new Set<string>();
  /**
   * Records the vendor of a schema, or of every schema nested in an object such as a `schemas` record.
   *
   * @param schemas - A schema, a record of schemas, or anything else (ignored).
   */
  const collect = (schemas: unknown): void => {
    if (isStandardSchema(schemas)) {
      vendors.add(schemas["~standard"].vendor);
      return;
    }
    if (typeof schemas === "object" && schemas !== null) {
      for (const value of Object.values(schemas))
        collect(value);
    }
  };
  const descriptor = getAppDescriptor(app);
  for (const resource of descriptor?.resources ?? [])
    collect(resource.schemas);
  for (const entry of descriptor?.config ?? [])
    collect(entry.schema);
  for (const module of modules) {
    for (const value of Object.values(module.exports))
      collect(getHandlerDescriptor(value)?.schemas);
  }
  return [...vendors].sort();
}

/**
 * Loads the schema adapter package for each vendor, by convention
 * `@holqa/<vendor>` (for example `@holqa/zod`), resolved from the application
 * root. A vendor without an installed adapter package gets none; the compiler
 * then falls back to the schema's own Standard JSON Schema converter with a
 * warning, or rejects the schema.
 *
 * @param root - The application root, where packages are resolved from.
 * @param vendors - The vendors the application uses.
 * @returns The adapters found, in vendor order.
 */
async function loadAdapters(root: string, vendors: readonly string[]): Promise<SchemaAdapter[]> {
  const adapters: SchemaAdapter[] = [];
  for (const vendor of vendors) {
    if (!adapterVendorPattern.test(vendor) || vendor === "holqa")
      continue;
    let resolved: string;
    try {
      resolved = Bun.resolveSync(`@holqa/${vendor}`, join(root, "package.json"));
    } catch {
      // No adapter package is installed for this vendor; the compiler reports what that means for each schema.
      continue;
    }
    const exports = await import(pathToFileURL(resolved).href) as Record<string, unknown>;
    const adapter = Object.values(exports).find((value): value is SchemaAdapter => isAdapterFor(value, vendor));
    if (adapter !== undefined)
      adapters.push(adapter);
  }
  return adapters;
}

/**
 * Reports whether a value is a schema adapter for a vendor.
 *
 * @param value - A module export.
 * @param vendor - The Standard Schema vendor.
 * @returns `true` for an object with that `vendor`, a `library` name and a `describe` function.
 */
function isAdapterFor(value: unknown, vendor: string): boolean {
  return typeof value === "object" && value !== null
    && "vendor" in value && value.vendor === vendor
    && "library" in value && typeof value.library === "string"
    && "describe" in value && typeof value.describe === "function";
}