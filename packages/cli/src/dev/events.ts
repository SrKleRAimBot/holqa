import type {
  EntrypointMap,
  Manifest,
  ManifestResource
} from "@holqa/compiler";
import type {
  Diagnostic,
  HandlerDefinition,
  JsonObject
} from "@holqa/core";

import type { ManifestChange } from "@/dev/classify";
import type { ReloadPlan } from "@/dev/reload-plan";
import type { SwapVersion } from "@/local/hot-swap";

import {
  httpEndpoint,
  nextCronTime,
  parseCronSchedule
} from "@holqa/core";

/** A resource as `holqa dev` lists it. */
export interface ResourceSummary extends JsonObject {
  readonly kind: string;
  readonly id: string;
  /** A short description of its settings, for example `base path /api` or `3 attempts, dead-letter`. */
  readonly details: string;
}

/** A handler as `holqa dev` lists it. */
export interface HandlerSummary extends JsonObject {
  readonly id: string;
  readonly trigger: string;
  readonly resourceId: string;
  /** Where it is implemented, `<module>#<export>`. */
  readonly source: string;
  /** For HTTP handlers: the methods and path, for example `POST /api/orders`. */
  readonly endpoint?: string;
}

/** What one generation runs. */
export interface ApplicationSummary extends JsonObject {
  readonly application: string;
  readonly fingerprint: string;
  readonly resources: readonly ResourceSummary[];
  readonly handlers: readonly HandlerSummary[];
  /** The next cron run of each schedule (ISO 8601). */
  readonly schedules: ReadonlyArray<{ readonly id: string; readonly nextRun?: string }>;
}

/**
 * Something that happened in a dev session. With `--json`, each event is
 * written to standard output as one JSON line, tagged with `type`. Consumers
 * should ignore event types and fields they do not know: new ones are added
 * in minor versions.
 *
 * `serving` names the generation that keeps running after a failure; `stale`
 * is `true` when that generation runs code from before the failed change.
 */
export type DevEvent
  = | { readonly type: "dev.listening"; readonly url: string; readonly stateDirectory: string; readonly buildDirectory: string; readonly watching: boolean; readonly hot?: boolean; readonly dashboard?: string }
    | { readonly type: "change"; readonly files: readonly string[] }
    | { readonly type: "build"; readonly generation: number; readonly change: ManifestChange; readonly fingerprint: string; readonly durationMs: number; readonly diagnostics: readonly Diagnostic[]; readonly reload?: ReloadPlan }
    | { readonly type: "build.failed"; readonly diagnostics: readonly Diagnostic[]; readonly serving?: number; readonly stale?: boolean }
    | { readonly type: "handlers.swapped"; readonly generation: number; readonly version: number; readonly handlers: readonly string[]; readonly modules: readonly string[]; readonly durationMs: number; readonly versions: readonly SwapVersion[] }
    | { readonly type: "handlers.swap-failed"; readonly generation: number; readonly diagnostics: readonly Diagnostic[]; readonly serving: number; readonly stale: true }
    | { readonly type: "handlers.swap-refused"; readonly generation: number; readonly reason: string; readonly diagnostics: readonly Diagnostic[] }
    | { readonly type: "generation.ready"; readonly generation: number; readonly pid: number; readonly durationMs: number; readonly summary: ApplicationSummary }
    | { readonly type: "generation.failed"; readonly generation: number; readonly diagnostics: readonly Diagnostic[]; readonly serving?: number; readonly stale?: boolean }
    | { readonly type: "generation.stopped"; readonly generation: number; readonly exitCode: number | null }
    | { readonly type: "generation.exited"; readonly generation: number; readonly exitCode: number | null }
    | { readonly type: "log"; readonly generation: number; readonly entry: JsonObject }
    | { readonly type: "output"; readonly generation: number; readonly stream: "stdout" | "stderr"; readonly line: string }
    | { readonly type: "dev.stopped" };

/**
 * Summarizes what a manifest declares, for the dev session's banner and its
 * `generation.ready` event.
 *
 * @param manifest - The manifest of the generation.
 * @param entrypoints - Where its handlers are implemented.
 * @param now - The current time, for the next schedule runs.
 * @returns The summary.
 */
export function summarize(manifest: Manifest, entrypoints: EntrypointMap, now: number): ApplicationSummary {
  const basePaths = new Map(manifest.resources.flatMap(resource => resource.kind === "http.api" ? [[resource.id as string, resource.config.basePath] as const] : []));
  const sources = new Map(entrypoints.handlers.map(handler => [handler.id as string, `${handler.module}#${handler.export}`]));
  return {
    application: manifest.application.name,
    fingerprint: entrypoints.manifest,
    resources: manifest.resources.map(resource => ({ kind: resource.kind, id: resource.id, details: describeResource(resource) })),
    handlers: manifest.handlers.map((handler): HandlerSummary => {
      const basePath = basePaths.get(handler.trigger.resource.id);
      const endpoint = basePath === undefined ? undefined : httpEndpoint(basePath, handler as unknown as HandlerDefinition);
      return {
        id: handler.id,
        trigger: handler.trigger.kind,
        resourceId: handler.trigger.resource.id,
        source: sources.get(handler.id) ?? "",
        ...endpoint === undefined ? {} : { endpoint: `${endpoint.methods.join(",")} ${endpoint.path}` }
      };
    }),
    schedules: manifest.resources.flatMap((resource) => {
      if (resource.kind !== "schedule")
        return [];
      const parsed = parseCronSchedule(resource.config.cron, resource.config.timezone);
      const next = parsed.ok ? nextCronTime(parsed.value, now) : undefined;
      return [{ id: resource.id, ...next === undefined ? {} : { nextRun: new Date(next).toISOString() } }];
    })
  };
}

/**
 * Describes a resource's settings in a few words.
 *
 * @param resource - A manifest resource.
 * @returns For example `base path /api` or `3 attempts, dead-letter`.
 */
function describeResource(resource: ManifestResource): string {
  switch (resource.kind) {
    case "http.api":
      return `base path ${resource.config.basePath}`;
    case "queue": {
      const { maxAttempts, deadLetter, backoff } = resource.requirements;
      return [maxAttempts === undefined ? "default attempts" : `${maxAttempts} attempts`, ...deadLetter ? ["dead-letter"] : [], ...backoff === undefined ? [] : [`${backoff.strategy} backoff`]].join(", ");
    }
    case "bucket":
      return `access ${resource.requirements.access}`;
    case "schedule":
      return `"${resource.config.cron}" ${resource.config.timezone}, overlap ${resource.requirements.overlap}`;
    case "static.site":
      return `${resource.config.directory} at ${resource.config.basePath}${resource.requirements.spaFallback ? ", SPA fallback" : ""}`;
  }
}