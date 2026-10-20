import type { EntrypointMap } from "@holqa/compiler";

import type { ManifestChange } from "@/dev/classify";
import type { ModuleGraph } from "@/dev/module-graph";

import {
  join,
  relative,
  sep
} from "node:path";

import { reachable } from "@/dev/module-graph";

/**
 * Why a reload restarts the application process instead of replacing
 * handlers in place:
 *
 * - `initial`: the first generation of the session.
 * - `requested`: a reload was requested without changed files.
 * - `hot-disabled`: hot replacement is turned off (`--no-hot`).
 * - `no-generation`: no generation is running to replace handlers in.
 * - `environment`: `.env` files changed; configuration is re-read by a new process.
 * - `dependencies`: package manifests, lockfiles, `tsconfig` or `bunfig` files changed.
 * - `contract`: the manifest changed: resources, configuration, handlers, triggers or schemas.
 * - `entrypoints`: a handler moved to another module or export.
 * - `application-module`: the application module or a module it imports changed; resources are evaluated once per process.
 * - `unreferenced-module`: a changed file is not imported by any handler (as far as static analysis sees), so its effect is unknown.
 * - `restart-marker`: an affected module contains the `holqa:restart-on-change` comment.
 * - `swap-limit`: the process has replaced handlers often enough that it is restarted to release old module copies.
 * - `side-effects`: evaluating the new modules created timers, listeners, servers or global names, which a replacement cannot manage.
 * - `replacement-rejected`: the runtime refused the replacement (a definition differs).
 */
export type RestartReason
  = | "initial"
    | "requested"
    | "hot-disabled"
    | "no-generation"
    | "environment"
    | "dependencies"
    | "contract"
    | "entrypoints"
    | "application-module"
    | "unreferenced-module"
    | "restart-marker"
    | "swap-limit"
    | "side-effects"
    | "replacement-rejected";

/** How a reload is applied. */
export type ReloadPlan
  = | {
    readonly strategy: "swap";
    /** The handler modules to rebuild, relative to the application root, sorted. */
    readonly modules: readonly string[];
    /** The handlers those modules implement, sorted. */
    readonly handlers: readonly string[];
  }
  | {
    readonly strategy: "restart";
    readonly reason: RestartReason;
    /** A sentence that explains the reason, naming the files involved. */
    readonly detail: string;
  };

/** What {@link planReload} decides from. */
export interface ReloadInput {
  /** The changed files, relative to the application root with `/` separators. */
  readonly files: readonly string[];
  /** The manifest change; `undefined` when no analysis ran (only `.env` files changed). */
  readonly change: ManifestChange | undefined;
  /** Whether hot replacement is enabled. */
  readonly hot: boolean;
  /** Whether a generation is serving. */
  readonly serving: boolean;
  /** The entry point map of the serving generation. */
  readonly previous: EntrypointMap | undefined;
  /** The entry point map of the new build. */
  readonly next: EntrypointMap | undefined;
  /** The import graph of the new build's modules. */
  readonly graph: ModuleGraph | undefined;
  /** How many replacements the serving generation has made. */
  readonly swaps: number;
  /** After how many replacements the process is restarted. */
  readonly maxSwaps: number;
}

/** Files whose changes alter how modules resolve or which dependencies load. */
const dependencyFile = /(?:^|\/)(?:package\.json|bun\.lockb?|pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bunfig\.toml|tsconfig(?:\.[^/]*)?\.json|jsconfig\.json)$/;

/**
 * Builds a restart plan.
 *
 * @param reason - Why.
 * @param detail - The explanation.
 * @returns The plan.
 */
function restart(reason: RestartReason, detail: string): ReloadPlan {
  return { strategy: "restart", reason, detail };
}

/**
 * Lists files for a message.
 *
 * @param files - Relative paths.
 * @returns At most three, then a count.
 */
function list(files: readonly string[]): string {
  return files.length <= 3 ? files.join(", ") : `${files.slice(0, 3).join(", ")} and ${files.length - 3} more`;
}

/**
 * Decides whether a reload can replace handlers in the running process or
 * must restart it. A replacement is chosen only when it is known to be safe:
 * the manifest and the entry point map are unchanged, every changed file is
 * a module that only handler modules import (not the application module or
 * anything it imports), and no affected module is marked for restarts.
 * Everything else restarts the process, which keeps the local state.
 *
 * Affected handler modules are those that import a changed file, directly or
 * indirectly. Handler modules that share any application module with an
 * affected one are rebuilt with it, so module state stays shared by exactly
 * the handlers that shared it before.
 *
 * @param input - The change and what is running.
 * @returns Whether to swap (and which modules) or restart (and why).
 */
export function planReload(input: ReloadInput): ReloadPlan {
  const { files, change, previous, next, graph } = input;
  if (previous === undefined || change?.kind === "initial")
    return restart("initial", "The first generation starts.");
  if (!input.hot)
    return restart("hot-disabled", "Hot replacement is turned off; every change restarts the application.");
  if (files.length === 0)
    return restart("requested", "A reload was requested without changed files.");
  if (!input.serving)
    return restart("no-generation", "No generation is running, so a new one starts.");
  if (change === undefined || change.kind === "environment")
    return restart("environment", "Environment files changed; a new process reads the configuration.");
  const dependencies = files.filter(file => dependencyFile.test(file));
  if (dependencies.length > 0)
    return restart("dependencies", `Dependency or compiler settings changed (${list(dependencies)}).`);
  if (change.kind !== "implementation")
    return restart("contract", `The application's ${change.kind === "resources" ? "resources or configuration" : "handlers, triggers or contracts"} changed.`);
  if (next === undefined || graph === undefined || JSON.stringify(previous.handlers) !== JSON.stringify(next.handlers) || previous.application.module !== next.application.module)
    return restart("entrypoints", "A handler moved to another module or export.");
  if (input.swaps >= input.maxSwaps)
    return restart("swap-limit", `The process replaced handlers ${input.swaps} times; it restarts to release the memory of old module copies.`);

  const { root } = graph;
  /**
   * Converts a relative path to the graph's absolute form.
   *
   * @param file - A path relative to the root, `/`-separated.
   * @returns The absolute path.
   */
  const absolute = (file: string): string => join(root, ...file.split("/"));
  /**
   * Converts an absolute path to the relative, `/`-separated form.
   *
   * @param file - An absolute path under the root.
   * @returns The path relative to the root, `/`-separated.
   */
  const relativePath = (file: string): string => relative(root, file).split(sep).join("/");
  const applicationModules = reachable(graph, absolute(next.application.module));
  const changed = files.map(absolute);
  const inApplication = changed.filter(file => applicationModules.has(file));
  if (inApplication.length > 0)
    return restart("application-module", `${list(inApplication.map(relativePath))} ${inApplication.length === 1 ? "is" : "are"} part of the application module's imports, which every handler shares.`);

  const handlerModules = [...new Set(next.handlers.map(entry => entry.module))].sort();
  const closures = new Map(handlerModules.map(module => [module, reachable(graph, absolute(module), applicationModules)]));
  const unreferenced = changed.filter(file => ![...closures.values()].some(closure => closure.has(file)));
  if (unreferenced.length > 0)
    return restart("unreferenced-module", `${list(unreferenced.map(relativePath))} ${unreferenced.length === 1 ? "is" : "are"} not imported by any handler module that holqa dev can follow.`);
  const affected = new Set(handlerModules.filter(module => changed.some(file => closures.get(module)!.has(file))));
  // Rebuild every handler module that shares a module with an affected one, until nothing more joins.
  for (let grew = true; grew;) {
    grew = false;
    const touched = new Set([...affected].flatMap(module => [...closures.get(module)!]));
    for (const module of handlerModules) {
      if (!affected.has(module) && [...closures.get(module)!].some(file => touched.has(file))) {
        affected.add(module);
        grew = true;
      }
    }
  }
  const marked = [...affected].flatMap(module => [...closures.get(module)!]).filter(file => graph.marked.has(file));
  if (marked.length > 0)
    return restart("restart-marker", `${list([...new Set(marked)].map(relativePath).sort())} ${marked.length === 1 ? "asks" : "ask"} for restarts (holqa:restart-on-change).`);
  const modules = [...affected].sort();
  return {
    strategy: "swap",
    modules,
    handlers: next.handlers.filter(entry => affected.has(entry.module)).map(entry => entry.id as string).sort()
  };
}

/**
 * Lists the modules a replacement must share with the running application
 * instead of evaluating new copies: the application module and every
 * application module it imports.
 *
 * @param graph - The import graph.
 * @param appModule - The application module, relative to the root.
 * @returns Absolute real paths, sorted.
 */
export function sharedModules(graph: ModuleGraph, appModule: string): string[] {
  return [...reachable(graph, join(graph.root, ...appModule.split("/")))].sort();
}