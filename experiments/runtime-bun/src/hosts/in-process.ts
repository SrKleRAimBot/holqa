import type { Result } from "@holqa/core";

import type { RuntimeDiagnostic } from "@/diagnostics";
import type {
  GenerationHost,
  HostOptions
} from "@/hosts/types";

import { ok } from "@holqa/core";

import { evictModuleCache } from "@/generation/load-graph";
import { prepareGeneration } from "@/generation/prepare";

/**
 * Loads a generation into the current thread (strategy A). Bun's module cache
 * entries under the application root are evicted first, so `infra.ts` and
 * every handler module are evaluated afresh and module-level state is not
 * shared with earlier generations. Handler module specifiers also carry a
 * per-generation query string. Dependencies in `node_modules` stay cached and
 * are shared.
 *
 * Disposal only unbinds the application: a handler that ignores its abort
 * signal keeps running, but any resource handle it uses afterwards fails with
 * `HOLQA_RUNTIME_NOT_BOUND`.
 *
 * @param options - Application location, configuration, backend and log sink.
 * @returns The host, or the diagnostics that prevented loading.
 */
export async function createInProcessHost(options: HostOptions): Promise<Result<GenerationHost, RuntimeDiagnostic[]>> {
  evictModuleCache(options.root);
  const prepared = await prepareGeneration({ ...options, cacheBust: `holqa-generation=${String(options.generation)}` });
  if (!prepared.ok)
    return prepared;
  const { registry, invoke, unbind } = prepared.value;
  return ok({
    strategy: "in-process",
    handlers: new Map([...registry.handlers].map(([id, handler]) => [id, handler.info])),
    resources: registry.resources,
    invoke,
    dispose: async () => unbind()
  });
}