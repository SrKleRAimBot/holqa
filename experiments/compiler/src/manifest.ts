import type {
  JsonObject,
  JsonValue
} from "@holqa/experiment-model";

/** The experimental manifest format version. `0` means "unstable, may change without notice". */
export const manifestVersion = 0;

/** How a schema was converted to JSON Schema. */
export type SchemaFidelity = "adapter" | "unverified";

/**
 * Where one schema role (for example a queue's `message`) points in the
 * manifest's schema table. A `null` fingerprint means that side could not be
 * represented; a diagnostic explains why.
 */
export interface ManifestSchemaUse {
  /** Fingerprint of what producers and clients send. */
  readonly input: string | null;
  /** Fingerprint of what consumers and handlers receive after validation and transformation. */
  readonly output: string | null;
  /** The converter that produced the JSON Schema, for example `zod-adapter (zod 4.6.7)`. */
  readonly converter: string;
  readonly fidelity: SchemaFidelity;
}

/** A normalized schema in the manifest's schema table, keyed by its fingerprint. */
export interface ManifestSchema {
  /** Normalized JSON Schema (draft 2020-12). */
  readonly jsonSchema: JsonObject;
  /** Constraints enforced at runtime that `jsonSchema` does not express. */
  readonly runtimeOnly: readonly string[];
}

/** A logical resource in the manifest. */
export interface ManifestResource {
  readonly id: string;
  readonly kind: string;
  readonly config: JsonObject;
  readonly schemas: Readonly<Record<string, ManifestSchemaUse>>;
}

/** A handler in the manifest. */
export interface ManifestHandler {
  readonly id: string;
  readonly trigger: JsonObject;
  readonly config: JsonObject;
  /** Module path relative to the application root, with `/` separators. */
  readonly module: string;
  /** The export names under which the handler was found, sorted. */
  readonly exports: readonly string[];
  readonly schemas: Readonly<Record<string, ManifestSchemaUse>>;
}

/** A configuration entry in the manifest. Values are never recorded; defaults only for non-sensitive variables. */
export interface ManifestConfig {
  readonly name: string;
  readonly sensitive: boolean;
  readonly schema: ManifestSchemaUse;
  readonly default?: JsonValue;
}

/** The deterministic, infrastructure-neutral description of an application. */
export interface Manifest {
  readonly manifestVersion: typeof manifestVersion;
  readonly app: {
    readonly name: string;
    readonly handlers: readonly string[];
  };
  readonly resources: readonly ManifestResource[];
  readonly handlers: readonly ManifestHandler[];
  readonly configuration: readonly ManifestConfig[];
  readonly schemas: Readonly<Record<string, ManifestSchema>>;
}