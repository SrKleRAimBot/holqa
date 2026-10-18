import type {
  HandlerDiscovery,
  ResourceId
} from "@holqa/core";

/** The format tag of version 1 of the entry point map. */
export const entrypointsFormat = "holqa.entrypoints/1";

/** Where a handler's code lives: build metadata, not identity. */
export interface HandlerEntrypoint {
  /** The handler's stable identifier, matching a `handlers[].id` in the manifest. */
  readonly id: ResourceId;
  /** The module path relative to the application root, with `/` separators. */
  readonly module: string;
  /** The export a runtime loads: `default` when the module exports the handler as default, otherwise the first name in `exports`. */
  readonly export: string;
  /** Every name under which the module exports the handler, sorted. */
  readonly exports: readonly string[];
}

/**
 * Build metadata that tells a bundler or runtime where each handler of a
 * manifest is implemented. It is deliberately separate from the manifest:
 * moving files or renaming exports changes this map, never the manifest.
 * Its relationship to the manifest is explicit through `manifest`, the
 * fingerprint of the serialized manifest it was produced with.
 */
export interface EntrypointMap {
  readonly format: typeof entrypointsFormat;
  /** `sha256:` fingerprint of the canonical manifest text this map belongs to. */
  readonly manifest: string;
  readonly application: {
    /** The application module path relative to the application root. */
    readonly module: string;
    /** The handler discovery patterns that selected the handler modules. */
    readonly handlers: HandlerDiscovery;
  };
  /** One entry per manifest handler, sorted by `id`. */
  readonly handlers: readonly HandlerEntrypoint[];
}