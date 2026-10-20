import type {
  JsonValue,
  ResourceId,
  ResourceKind,
  ResourceKindMap,
  TriggerKind,
  TriggerKindMap
} from "@holqa/core";

import type {
  SchemaContract,
  SchemaSource
} from "@/schema/schema-contract";

/**
 * The manifest format version this compiler writes and reads. Readers reject
 * other versions. Any change to the manifest's structure or to the
 * normalization rules that feed it (and therefore its bytes) requires a new version.
 */
export const manifestVersion = 1;

/** The literal type of {@link manifestVersion}. */
export type ManifestVersion = typeof manifestVersion;

/** The execution runtimes a manifest can target. Only Bun exists today (ADR 0002). */
export const manifestRuntimes = ["bun"] as const;

/** An execution runtime a manifest targets. */
export type ManifestRuntime = (typeof manifestRuntimes)[number];

/**
 * A pointer from a declaration's schema role (for example a queue's `message`)
 * to an entry of the manifest's schema table.
 */
export interface ManifestSchemaReference {
  /** The key of the schema table entry: `sha256:` and 64 hex digits. */
  readonly fingerprint: string;
  /** The library and converter that described this use of the schema. Kept per use because it is not part of the fingerprint. */
  readonly source: SchemaSource;
  /** The declared contract version, present where the declaration versions its contract (queue messages). */
  readonly schemaVersion?: number;
}

/**
 * A schema in the manifest's schema table: a canonical schema contract
 * without its `source`, which every reference records instead. Two uses with
 * the same fingerprint share one entry.
 */
export type ManifestSchema = Omit<SchemaContract, "source">;

/** Schema references keyed by role, for example `message`, `body` or `response.200`. */
export type ManifestSchemaReferences = Readonly<Record<string, ManifestSchemaReference>>;

/**
 * A logical resource in the manifest: identity, kind, normalized
 * configuration and requirements, and schema references. Never provider-specific.
 *
 * @typeParam Kind - Which registered kind the entry describes, such as `queue`.
 */
export interface ManifestResourceOf<Kind extends ResourceKind> {
  readonly id: ResourceId;
  readonly kind: Kind;
  readonly config: ResourceKindMap[Kind]["config"];
  readonly requirements: ResourceKindMap[Kind]["requirements"];
  readonly schemas: ManifestSchemaReferences;
}

/** Any manifest resource, discriminated by `kind`. */
export type ManifestResource = { [Kind in ResourceKind]: ManifestResourceOf<Kind> }[ResourceKind];

/**
 * What invokes a handler: the trigger kind, the referenced resource and the
 * trigger's normalized options.
 *
 * @typeParam Trigger - The trigger kind.
 */
export interface ManifestTriggerOf<Trigger extends TriggerKind> {
  readonly kind: Trigger;
  readonly resource: {
    readonly kind: TriggerKindMap[Trigger]["resource"];
    readonly id: ResourceId;
  };
  readonly options: TriggerKindMap[Trigger]["options"];
}

/** Any manifest trigger, discriminated by `kind`. */
export type ManifestTrigger = { [Kind in TriggerKind]: ManifestTriggerOf<Kind> }[TriggerKind];

/**
 * A handler in the manifest, identified only by its stable `id`. Module paths
 * and export names are build metadata and live in the entry point map, so
 * moving or renaming a file never changes the manifest.
 */
export interface ManifestHandler {
  readonly id: ResourceId;
  readonly trigger: ManifestTrigger;
  readonly schemas: ManifestSchemaReferences;
}

/**
 * A required configuration entry (an environment binding). The manifest
 * records that a value is required and its schema, never a value. Defaults
 * appear only for non-sensitive variables.
 */
export interface ManifestConfigEntry {
  /** The entry's name, which is also its environment variable name. */
  readonly name: string;
  readonly kind: "secret" | "variable";
  readonly schema: ManifestSchemaReference;
  /** The default value of a variable. Secrets never have one. */
  readonly default?: JsonValue;
}

/** A provider extension an application declares: its identifier, version and whether it is required. */
export interface ManifestExtension {
  readonly id: string;
  readonly version: number;
  readonly required: boolean;
}

/** The application a manifest describes. */
export interface ManifestApplication {
  readonly name: ResourceId;
  readonly description?: string;
}

/**
 * The deterministic, versioned, infrastructure-neutral description of an
 * application: what the compiler hands to runtimes, local tooling, providers
 * and inspection tools. Every list is sorted by identity, and the serialized
 * form is canonical JSON, so equal applications produce equal bytes.
 */
export interface Manifest {
  readonly manifestVersion: ManifestVersion;
  readonly application: ManifestApplication;
  readonly runtime: ManifestRuntime;
  /** Every declared resource, sorted by `id`. */
  readonly resources: readonly ManifestResource[];
  /** Every discovered handler, sorted by `id`. */
  readonly handlers: readonly ManifestHandler[];
  /** Every configuration entry, sorted by `name`. */
  readonly config: readonly ManifestConfigEntry[];
  /** Infrastructure capabilities the application requires from a binding, sorted and unique. */
  readonly requiredCapabilities: readonly string[];
  /** Normalized schema contracts keyed by fingerprint. */
  readonly schemas: Readonly<Record<string, ManifestSchema>>;
  /** The provider extensions the application declares, sorted by `id`. Absent when it declares none. */
  readonly extensions?: readonly ManifestExtension[];
}