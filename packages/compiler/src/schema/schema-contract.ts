import type {
  SchemaConversionProblem,
  SchemaSideDescription
} from "@holqa/core";

/** The format tag of version 1 of Holqa's canonical schema contract. */
export const schemaContractFormat = "holqa.schema-contract/1";

/** The JSON Schema dialect every contract uses. */
export const jsonSchemaDialect = "https://json-schema.org/draft/2020-12/schema";

/**
 * How far a contract's description can be trusted. `verified` means a
 * library-specific adapter produced it and reported every construct it could
 * not describe. `unverified` means a generic Standard JSON Schema converter
 * produced it, which may drop constraints without saying so.
 */
export type SchemaFidelity = "verified" | "unverified";

/** Where a contract's description came from. Not part of the fingerprint. */
export interface SchemaSource {
  /** The Standard Schema vendor, for example `zod`. */
  readonly vendor: string;
  /** The converting library and version, for example `zod@4.6.7`. */
  readonly library: string;
  readonly fidelity: SchemaFidelity;
}

/**
 * The description of what consumers receive. A schema whose output cannot be
 * described (for example a transform producing a `Date`) is still a valid wire
 * contract: the wire carries the input side.
 */
export type SchemaOutputContract
  = | ({ readonly representable: true } & SchemaSideDescription)
    | { readonly representable: false; readonly problem: SchemaConversionProblem };

/**
 * Holqa's canonical, JSON-serializable description of a schema: the portable
 * contract the compiler records, fingerprints and compares. Its JSON Schemas
 * are in canonical form (see `canonicalizeJsonSchema`).
 */
export interface SchemaContract {
  readonly format: typeof schemaContractFormat;
  readonly dialect: typeof jsonSchemaDialect;
  /** How payloads travel on the wire. Only `json` exists today. */
  readonly encoding: "json";
  readonly source: SchemaSource;
  /** What producers send and what travels on the wire. Always portable. */
  readonly input: SchemaSideDescription;
  readonly output: SchemaOutputContract;
}

/**
 * A contract together with its declared version and fingerprint: the unit the
 * compiler stores per message, request or response schema, and the metadata
 * later migration tooling starts from.
 */
export interface SchemaContractRecord {
  /** The declared `schemaVersion`. A positive integer, increased for breaking changes. */
  readonly schemaVersion: number;
  /** `sha256:` followed by 64 lowercase hex digits; see `fingerprintSchemaContract`. */
  readonly fingerprint: string;
  readonly contract: SchemaContract;
}