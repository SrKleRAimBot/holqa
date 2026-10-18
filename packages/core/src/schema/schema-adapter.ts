import type { JsonObject } from "@/json";
import type { Result } from "@/result";
import type { StandardSchemaV1 } from "@/schema/standard-schema";

/**
 * Which side of a schema to describe. `input` is what producers send and what
 * travels on the wire; `output` is what consumers receive after validation and
 * transformation.
 */
export type SchemaSide = "input" | "output";

/** Every schema side, in a fixed order. */
export const schemaSides = Object.freeze(["input", "output"] as const) satisfies readonly SchemaSide[];

/**
 * Why a constraint is enforced at runtime but absent from the portable description.
 *
 * - `refinement`: a custom predicate such as Zod's `.refine()` or `.superRefine()`.
 * - `rewrite`: the value is rewritten during validation, such as `.trim()` or `.toLowerCase()`.
 * - `coercion`: input is coerced, so values the JSON Schema rejects may be accepted.
 * - `preprocess`: input passes through a function before it is validated.
 * - `fallback`: invalid input is replaced by a fallback value instead of being rejected.
 * - `pipe`: a second schema validates the value after the described one.
 * - `check`: any other library check the adapter does not recognize.
 */
export type RuntimeOnlyKind = "refinement" | "rewrite" | "coercion" | "preprocess" | "fallback" | "pipe" | "check";

/** A constraint the schema enforces at runtime that its JSON Schema does not express. */
export interface RuntimeOnlyConstraint {
  /** JSON path of the constrained value, for example `$.lines[*].sku`. */
  readonly path: string;
  readonly kind: RuntimeOnlyKind;
  /** Human-readable description of the constraint. */
  readonly detail: string;
}

/** A portable description of one schema side. */
export interface SchemaSideDescription {
  /** JSON Schema (draft 2020-12) of the side, without the `$schema` keyword. */
  readonly jsonSchema: JsonObject;
  /** Constraints enforced at runtime but missing from `jsonSchema`. Empty when the description is complete. */
  readonly runtimeOnly: readonly RuntimeOnlyConstraint[];
}

/** Why a schema side has no faithful portable description. */
export interface SchemaConversionProblem {
  /** JSON path of the offending construct, for example `$.createdAt`. */
  readonly path: string;
  /** What cannot be represented and why. */
  readonly reason: string;
  /** Optional guidance, for example the portable construct to use instead. */
  readonly hint?: string;
}

/** The outcome of describing one schema side: a description, or the reason none can be given. */
export type SchemaSideConversion = Result<SchemaSideDescription, SchemaConversionProblem>;

/**
 * Describes one schema library's schemas portably and reports exactly what the
 * description loses. Adapters live in integration packages (for example
 * `@holqa/zod`) and may read their library's internals; core and the compiler
 * never import a schema library.
 *
 * An adapter must never return an approximate description. A construct it
 * cannot describe faithfully is either a {@link RuntimeOnlyConstraint} (still
 * validated at runtime) or a {@link SchemaConversionProblem}.
 */
export interface SchemaAdapter {
  /** The Standard Schema `vendor` this adapter handles, for example `zod`. */
  readonly vendor: string;
  /** Library and version, for example `zod@4.6.7`. Recorded so description changes after an upgrade are explainable. */
  readonly library: string;
  /**
   * Describes one side of a schema.
   *
   * @param schema - A schema whose `~standard.vendor` equals {@link SchemaAdapter.vendor}.
   * @param side - Which side to describe.
   * @returns The description, or why the side cannot be represented.
   */
  readonly describe: (schema: StandardSchemaV1, side: SchemaSide) => SchemaSideConversion;
}