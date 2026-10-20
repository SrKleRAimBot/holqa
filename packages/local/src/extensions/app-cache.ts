import type {
  BindingProvider,
  ExtensionDefinition,
  ProviderInstance
} from "@holqa/core";

import type { Clock } from "@/clock";

import {
  bindingProtocolVersion,
  createDiagnostic,
  defineExtension,
  diagnosticCodes,
  failWith,
  HolqaError
} from "@holqa/core";

import { systemClock } from "@/clock";

/** Settings of one cache write. */
export interface AppCacheSetOptions {
  /** How long the entry lives, in whole seconds of at least 1. Absent: until it is evicted or deleted. */
  readonly ttlSeconds?: number;
}

/**
 * A small key-value cache for derived data an application can recompute:
 * the operations of the `holqa.app-cache` extension. Implementations may
 * evict entries at any time, so callers treat every read as optional.
 */
export interface AppCache {
  /** Returns the value of a live entry, or `undefined`. */
  readonly get: (key: string) => Promise<string | undefined>;
  /** Stores a value, replacing an existing one. */
  readonly set: (key: string, value: string, options?: AppCacheSetOptions) => Promise<void>;
  /** Removes an entry; resolves to `false` when there was none. */
  readonly delete: (key: string) => Promise<boolean>;
}

/**
 * The reference extension: an application cache. Applications declare it in
 * `defineApp({ extensions: { required: [appCacheExtension] } })` (or as
 * optional) and use it through `app.extensions`; a binding configuration
 * selects an implementation, such as {@link localAppCache}.
 */
export const appCacheExtension: ExtensionDefinition<AppCache> = defineExtension<AppCache>({
  id: "holqa.app-cache",
  version: 1,
  description: "A key-value cache for derived data that can be recomputed; entries may be evicted at any time."
});

/** Settings of {@link localAppCache}. */
export interface LocalAppCacheOptions {
  /** The provider's name. Default `local.app-cache`. */
  readonly name?: string;
  /** The most entries kept; the least recently used is evicted beyond it. Default 1 000. */
  readonly maxEntries?: number;
  /** The time source of expiry. Default the wall clock; use a `ManualClock` in tests. */
  readonly clock?: Clock;
}

/** The largest key or value accepted, in UTF-16 code units, so one entry cannot exhaust memory. */
const maxLength = 1_048_576;

/**
 * Creates the local implementation of the application cache: entries in
 * process memory, bounded by `maxEntries` with least-recently-used eviction,
 * expiring by the given clock. It needs no credentials, no infrastructure and
 * no privileges, and loses everything when the binding stops. It is not
 * shared between processes.
 *
 * @example
 * ```ts
 * defineBindings(app, { defaults: local.platform(), extensions: [localAppCache()] });
 * ```
 *
 * @param options - Name, size bound and clock.
 * @returns A service provider implementing `holqa.app-cache` version 1.
 * @throws {HolqaError} `HOLQA_BINDING_CONFIG_INVALID` for an invalid `maxEntries` or name.
 */
export function localAppCache(options: LocalAppCacheOptions = {}): BindingProvider {
  const maxEntries = options.maxEntries ?? 1_000;
  if (!(Number.isSafeInteger(maxEntries) && maxEntries >= 1))
    failWith(diagnosticCodes.bindingConfigInvalid, "The local application cache setting \"maxEntries\" must be a whole number of at least 1.");
  const name = options.name ?? "local.app-cache";
  if (!/^[a-z][a-z0-9-]*(?:\.[a-z0-9-]+)*$/.test(name))
    failWith(diagnosticCodes.bindingConfigInvalid, "The local application cache setting \"name\" must be lowercase letters, digits and hyphens, in dot-separated segments.");
  const clock = options.clock ?? systemClock;
  return Object.freeze({
    bindingProtocol: bindingProtocolVersion,
    provider: "holqa.local",
    name,
    role: "service",
    contracts: Object.freeze({}),
    resources: Object.freeze({}),
    services: Object.freeze({}),
    extensions: Object.freeze([Object.freeze({ id: appCacheExtension.id, version: appCacheExtension.version })]),
    topology: Object.freeze({ delivery: "none", state: "process" }),
    settings: Object.freeze({ maxEntries }),
    open: async (): Promise<ProviderInstance> => {
      // Insertion order is recency order: a read re-inserts the entry.
      const entries = new Map<string, { readonly value: string; readonly expiresAt: number | undefined }>();
      let stopped = false;
      /**
       * Checks a key or value.
       *
       * @param value - The candidate.
       * @param what - `key` or `value`, for the message.
       * @throws {HolqaError} `HOLQA_OPERATION_INVALID` for a non-string, an empty key, or one longer than 1 MiB of code units.
       */
      const check = (value: unknown, what: string): void => {
        if (typeof value !== "string" || (what === "key" && value === "") || value.length > maxLength)
          throw new HolqaError(createDiagnostic({ code: diagnosticCodes.operationInvalid, severity: "error", message: `The application cache ${what} must be a ${what === "key" ? "non-empty " : ""}string of at most ${maxLength} characters.` }));
      };
      /** Fails an operation after the binding stopped. */
      const ensureOpen = (): void => {
        if (stopped)
          failWith(diagnosticCodes.runtimeNotRunning, "The application cache was used after its binding stopped.");
      };
      const cache: AppCache = Object.freeze({
        get: async (key: string) => {
          ensureOpen();
          check(key, "key");
          const entry = entries.get(key);
          if (entry === undefined)
            return undefined;
          entries.delete(key);
          if (entry.expiresAt !== undefined && entry.expiresAt <= clock.now())
            return undefined;
          entries.set(key, entry);
          return entry.value;
        },
        set: async (key: string, value: string, setOptions: AppCacheSetOptions = {}) => {
          ensureOpen();
          check(key, "key");
          check(value, "value");
          const ttl = setOptions.ttlSeconds;
          if (ttl !== undefined && !(Number.isSafeInteger(ttl) && ttl >= 1))
            failWith(diagnosticCodes.operationInvalid, "\"ttlSeconds\" must be a whole number of at least 1.");
          entries.delete(key);
          entries.set(key, Object.freeze({ value, expiresAt: ttl === undefined ? undefined : clock.now() + ttl * 1000 }));
          while (entries.size > maxEntries)
            entries.delete(entries.keys().next().value!);
        },
        delete: async (key: string) => {
          ensureOpen();
          check(key, "key");
          return entries.delete(key);
        }
      });
      return Object.freeze({
        extensions: Object.freeze({ [appCacheExtension.id]: cache }),
        health: async () => ({ status: "healthy" as const, details: { entries: entries.size } }),
        stop: async () => {
          stopped = true;
          entries.clear();
        }
      });
    }
  } satisfies BindingProvider);
}