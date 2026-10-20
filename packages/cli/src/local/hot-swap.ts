import type { Diagnostic } from "@holqa/core";
import type {
  HandlerVersionInfo,
  Runtime
} from "@holqa/runtime-bun";
import type { BunPlugin } from "bun";

import type { CapturedEffect } from "@/local/effect-capture";
import {
  realpathSync,
  rmSync
} from "node:fs";
import {
  isAbsolute,
  join,
  relative,
  resolve,
  sep
} from "node:path";

import {
  createDiagnostic,
  diagnosticCodes,
  diagnosticsOf
} from "@holqa/core";

import { captureEffects } from "@/local/effect-capture";

/** What the supervisor asks a generation to replace. */
export interface SwapRequest {
  /** The handler modules to rebuild, relative to the application root. */
  readonly modules: readonly string[];
  /** Modules the new code must share with the running application instead of evaluating copies (the application module's imports), absolute. */
  readonly shared: readonly string[];
}

/** A handler version as the generation reports it, JSON data. */
export interface SwapVersion {
  readonly handlerId: string;
  readonly version: number;
  readonly active: number;
  readonly retiring: ReadonlyArray<{ readonly version: number; readonly active: number }>;
}

/** The outcome of a replacement in a generation. */
export type SwapOutcome
  = | {
    readonly ok: true;
    /** The new registry version. */
    readonly version: number;
    /** The replaced handlers. */
    readonly handlers: readonly string[];
    readonly durationMs: number;
    /** Every handler's versions after the replacement. */
    readonly versions: readonly SwapVersion[];
  }
  | {
    readonly ok: false;
    /**
     * `true` when the change is valid but cannot be applied in place (the
     * supervisor restarts the process instead); `false` when the new code
     * is broken and the running implementations keep serving.
     */
    readonly restart: boolean;
    /** Why a restart is needed: `side-effects` or `replacement-rejected`. */
    readonly reason?: "side-effects" | "replacement-rejected";
    readonly diagnostics: readonly Diagnostic[];
  };

/** One handler of the entry point map. */
export interface HandlerEntry {
  readonly id: string;
  readonly module: string;
  readonly export: string;
}

/** Settings of {@link HotSwapper}. */
export interface HotSwapperOptions {
  /** The application root. */
  readonly root: string;
  /** Where replacement builds are written; removed by {@link HotSwapper.dispose}. */
  readonly outDir: string;
  /** Every handler of the running build. */
  readonly handlers: readonly HandlerEntry[];
  readonly runtime: Runtime;
}

/**
 * Converts the runtime's version list into JSON data.
 *
 * @param versions - The runtime's handler versions.
 * @returns The versions without source locations.
 */
export function swapVersions(versions: readonly HandlerVersionInfo[]): SwapVersion[] {
  return versions.map(({ handlerId, version, active, retiring }) => ({ handlerId, version, active, retiring: retiring.map(entry => ({ ...entry })) }));
}

/**
 * Replaces handler implementations inside a running generation.
 *
 * Each replacement bundles the affected handler modules (with Bun's bundler)
 * into a new directory, so they and the application modules only they import
 * are evaluated afresh, while the application module, the modules it
 * imports, files outside the application root and packages stay the
 * instances the running application already uses: handles stay bound to the
 * running application, and resources are not evaluated twice. The bundle is
 * evaluated synchronously while timers, listeners, servers and new globals
 * are observed; any of them refuses the replacement (and is undone), because
 * the old copy's effects could not be cleaned up. Only then are the new
 * implementations installed, atomically, through `runtime.replaceHandlers`.
 *
 * Old module copies cannot be unloaded from Bun's module registry, so each
 * replacement keeps some memory; the supervisor restarts the process after a
 * bounded number of replacements.
 */
export class HotSwapper {
  /** Settings. */
  private readonly options: HotSwapperOptions;
  /** Replacement builds so far. */
  private sequence = 0;

  /**
   * Creates a swapper for a running generation.
   *
   * @param options - The application root, build directory, handlers and runtime.
   */
  constructor(options: HotSwapperOptions) {
    this.options = options;
  }

  /**
   * Builds, evaluates and installs new implementations of the handlers of some modules.
   *
   * @param request - The modules to rebuild and the modules to share.
   * @returns The outcome; never rejects.
   */
  async swap(request: SwapRequest): Promise<SwapOutcome> {
    const started = performance.now();
    const root = realpathSync(this.options.root);
    const outDir = join(this.options.outDir, String(++this.sequence));
    const modules = new Set(request.modules);
    const entries = this.options.handlers.filter(entry => modules.has(entry.module));
    if (entries.length === 0)
      return { ok: false, restart: true, reason: "replacement-rejected", diagnostics: [failure("The requested modules implement no handler.")] };
    const report: PluginReport = { unshared: [] };
    let built: Awaited<ReturnType<typeof Bun.build>>;
    try {
      built = await Bun.build({
        entrypoints: request.modules.map(module => join(root, module)),
        root,
        outdir: outDir,
        naming: { entry: "[dir]/[name].[ext]", chunk: "chunks/[name]-[hash].[ext]" },
        target: "bun",
        format: "esm",
        splitting: true,
        sourcemap: "inline",
        throw: false,
        plugins: [sharedModulesPlugin(root, new Set(request.shared.map(path => realpathOrSelf(path))), report)]
      });
    } catch (error) {
      return { ok: false, restart: false, diagnostics: [failure(`Building the replacement failed: ${error instanceof Error ? error.message : String(error)}`)] };
    }
    if (!built.success) {
      const diagnostics = built.logs.filter(log => log.level === "error").map(log => createDiagnostic({
        code: diagnosticCodes.moduleEvaluationFailed,
        severity: "error",
        message: log.message,
        ...log.position === null ? {} : { location: { file: relativeTo(root, log.position.file), line: log.position.line, column: log.position.column } }
      }));
      return { ok: false, restart: false, diagnostics: diagnostics.length > 0 ? diagnostics : [failure("Building the replacement failed.")] };
    }
    if (report.unshared.length > 0)
      return { ok: false, restart: true, reason: "replacement-rejected", diagnostics: [createDiagnostic({ code: diagnosticCodes.reloadFailed, severity: "info", message: `The imports ${[...new Set(report.unshared)].map(specifier => JSON.stringify(specifier)).join(", ")} of shared modules could not be redirected to the running application, so the application restarts instead.` })] };
    await Promise.all(built.outputs.filter(output => output.kind === "entry-point" || output.kind === "chunk").map(output => fixSourceMap(output.path, outDir)));

    let evaluated: ReturnType<typeof captureEffects<Map<string, Readonly<Record<string, unknown>>>>>;
    try {
      evaluated = captureEffects(() => {
        const exports = new Map<string, Readonly<Record<string, unknown>>>();
        for (const module of request.modules) {
          const path = join(outDir, module.replace(/\.[cm]?[jt]sx?$/, ".js"));
          exports.set(module, import.meta.require(path) as Readonly<Record<string, unknown>>);
        }
        return exports;
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Modules with top-level await cannot be evaluated synchronously, so their effects cannot be observed: restart instead.
      if (/async module|top-level await/i.test(message))
        return { ok: false, restart: true, reason: "side-effects", diagnostics: [createDiagnostic({ code: diagnosticCodes.reloadFailed, severity: "info", message: "The changed modules use top-level await, which cannot be evaluated in place; the application restarts instead." })] };
      return { ok: false, restart: false, diagnostics: [createDiagnostic({ code: diagnosticCodes.moduleEvaluationFailed, severity: "error", message: `Evaluating the new code failed: ${message}` })] };
    }
    if (evaluated.effects.length > 0 || evaluated.globals.length > 0) {
      for (const effect of evaluated.effects)
        effect.undo();
      return { ok: false, restart: true, reason: "side-effects", diagnostics: [sideEffects(evaluated.effects, evaluated.globals)] };
    }
    const registrations: unknown[] = [];
    const sources: Record<string, string> = {};
    for (const entry of entries) {
      registrations.push(evaluated.value.get(entry.module)?.[entry.export]);
      sources[entry.id] = `${entry.module}#${entry.export}`;
    }
    try {
      const replaced = this.options.runtime.replaceHandlers(registrations, { sources });
      return { ok: true, version: replaced.version, handlers: replaced.handlers, durationMs: Math.round(performance.now() - started), versions: swapVersions(this.options.runtime.handlerVersions()) };
    } catch (error) {
      return { ok: false, restart: true, reason: "replacement-rejected", diagnostics: diagnosticsOf(error) };
    }
  }

  /** Removes the replacement builds; the evaluated code stays loaded. */
  dispose(): void {
    rmSync(this.options.outDir, { recursive: true, force: true });
  }
}

/**
 * Builds the diagnostic of a failed replacement.
 *
 * @param message - What failed.
 * @returns A `HOLQA_RELOAD_FAILED` error.
 */
function failure(message: string): Diagnostic {
  return createDiagnostic({ code: diagnosticCodes.reloadFailed, severity: "error", message });
}

/**
 * Describes module-level effects that prevent a replacement.
 *
 * @param effects - The captured effects.
 * @param globals - Global names the modules added.
 * @returns An informational diagnostic.
 */
function sideEffects(effects: readonly CapturedEffect[], globals: readonly string[]): Diagnostic {
  const apis = [...new Set(effects.map(effect => effect.api))].sort();
  const parts = [...apis.length === 0 ? [] : [`called ${apis.join(", ")}`], ...globals.length === 0 ? [] : [`added the globals ${globals.join(", ")}`]];
  return createDiagnostic({
    code: diagnosticCodes.reloadFailed,
    severity: "info",
    message: `The changed modules ${parts.join(" and ")} while loading; the previous copies' effects cannot be cleaned up in place, so the application restarts instead.`,
    hint: "Create timers, listeners and connections inside handlers or scoped values (whose dispose releases them), not at module top level."
  });
}

/**
 * Resolves a path to its real path, keeping it when it does not exist.
 *
 * @param path - An absolute path.
 * @returns The real path.
 */
function realpathOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    // A shared module that no longer exists cannot be imported either way; the analysis reports it.
    return path;
  }
}

/**
 * Formats a path relative to the root when it is inside it.
 *
 * @param root - The application root.
 * @param path - A path from the bundler.
 * @returns The relative path, `/`-separated, or the path unchanged.
 */
function relativeTo(root: string, path: string): string {
  const from = relative(root, path);
  return from.startsWith("..") || isAbsolute(from) ? path : from.split(sep).join("/");
}

/** The loaders of the source extensions a replacement build reads. */
const sourceLoaders: Readonly<Record<string, "ts" | "tsx" | "js" | "jsx">> = { ".ts": "ts", ".mts": "ts", ".cts": "ts", ".tsx": "tsx", ".js": "js", ".mjs": "js", ".cjs": "js", ".jsx": "jsx" };

/**
 * Escapes text for use in a regular expression.
 *
 * @param text - Any text.
 * @returns The text with every special character escaped.
 */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** What {@link sharedModulesPlugin} observed. */
interface PluginReport {
  /** Imports of shared modules that could not be redirected to the running instance. */
  readonly unshared: string[];
}

/**
 * The bundler plugin that keeps shared modules out of a replacement build.
 * Packages, built-in modules, files outside the application root and the
 * application module's imports are imported from the running process, so
 * the new code uses the same instances (and the handles bound to the running
 * application).
 *
 * Bun keeps an external import's specifier as written, which would resolve
 * relative to the output directory. Application modules are therefore loaded
 * with their imports of shared modules rewritten to absolute paths, and
 * those absolute imports are the external ones. (Re-exporting shared modules
 * through proxy modules does not work: Bun 1.3 miscompiles `export *` from
 * an external module.)
 *
 * @param root - The application root, as a real path.
 * @param shared - The application modules to share, as real paths.
 * @param report - Receives imports that could not be redirected.
 * @returns A Bun bundler plugin.
 */
function sharedModulesPlugin(root: string, shared: ReadonlySet<string>, report: PluginReport): BunPlugin {
  /**
   * Resolves an import and decides whether it is shared.
   *
   * @param specifier - The import specifier.
   * @param directory - The importing module's directory.
   * @returns `external` with the absolute target for shared modules, `package` for imports kept as written, or `bundle`.
   */
  const classify = (specifier: string, directory: string): { readonly kind: "external"; readonly target: string } | { readonly kind: "package" | "bundle" } => {
    let resolved: string;
    try {
      resolved = Bun.resolveSync(specifier, directory);
    } catch {
      // Let the bundler report the unresolved import with its location.
      return { kind: "bundle" };
    }
    if (!isAbsolute(resolved))
      return { kind: "package" };
    const target = realpathOrSelf(resolved);
    const from = relative(root, target);
    const inPackage = from.split(sep).includes("node_modules");
    // A package imported by name resolves the same way from the output directory, which is inside the root.
    if (inPackage && !/^[./]/.test(specifier))
      return { kind: "package" };
    if (inPackage || from.startsWith("..") || isAbsolute(from) || shared.has(target))
      return { kind: "external", target };
    return { kind: "bundle" };
  };
  return {
    name: "holqa-shared-modules",
    setup(build) {
      build.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, async (args) => {
        const loader = sourceLoaders[args.path.slice(args.path.lastIndexOf("."))];
        const from = relative(root, args.path);
        if (loader === undefined || from.startsWith("..") || isAbsolute(from) || from.split(sep).includes("node_modules"))
          return undefined;
        let contents = await Bun.file(args.path).text();
        const directory = args.path.slice(0, args.path.lastIndexOf("/"));
        let imports: ReadonlyArray<{ readonly path: string }>;
        try {
          imports = new Bun.Transpiler({ loader }).scanImports(contents);
        } catch {
          // A syntax error: the bundler parses the file itself and reports the error with its location.
          return undefined;
        }
        for (const { path: specifier } of imports) {
          const decision = classify(specifier, directory);
          if (decision.kind !== "external" || isAbsolute(specifier))
            continue;
          const pattern = new RegExp(`(\\bfrom\\s*|\\bimport\\s*\\(\\s*|\\bimport\\s+|\\brequire\\s*\\(\\s*)(["'])${escapeRegExp(specifier)}\\2`, "g");
          contents = contents.replace(pattern, (_match, prefix: string) => `${prefix}${JSON.stringify(decision.target)}`);
        }
        return { contents, loader };
      });
      build.onResolve({ filter: /.*/ }, (args) => {
        if (args.kind === "entry-point-build" || args.kind === "entry-point-run")
          return undefined;
        const decision = classify(args.path, args.resolveDir);
        if (decision.kind === "package")
          return { path: args.path, external: true };
        if (decision.kind === "bundle")
          return undefined;
        if (!isAbsolute(args.path))
          report.unshared.push(args.path);
        return { path: args.path, external: true };
      });
    }
  };
}

/**
 * Rewrites an output file's inline source map so stack traces name the
 * original files: Bun records sources relative to the output directory,
 * which its runtime resolves relative to the file.
 *
 * @param path - The output file.
 * @param outDir - The output directory.
 */
async function fixSourceMap(path: string, outDir: string): Promise<void> {
  const text = await Bun.file(path).text();
  const match = /\/\/# sourceMappingURL=data:application\/json;base64,(\S+)\s*$/.exec(text);
  if (match === null)
    return;
  const map = JSON.parse(Buffer.from(match[1]!, "base64").toString("utf8")) as { sources?: unknown };
  if (!Array.isArray(map.sources))
    return;
  map.sources = (map.sources as unknown[]).map(source => typeof source === "string" && !isAbsolute(source) ? resolve(outDir, source) : source);
  await Bun.write(path, `${text.slice(0, match.index)}//# sourceMappingURL=data:application/json;base64,${Buffer.from(JSON.stringify(map)).toString("base64")}\n`);
}