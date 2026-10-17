import type {
  DiagnosticLocation,
  Result
} from "@holqa/core";
import type {
  JsonObject,
  SchemaAdapter,
  SchemaConversion,
  SchemaConversionFailure,
  SchemaSide,
  StandardSchemaV1
} from "@holqa/experiment-model";

import type { CompilerDiagnostic } from "@/diagnostics";
import type {
  ManifestSchema,
  ManifestSchemaUse
} from "@/manifest";

import {
  err,
  ok
} from "@holqa/core";
import {
  experimentCodes,
  experimentDiagnostic,
  hasStandardJsonSchema,
  isJsonValue
} from "@holqa/experiment-model";

import {
  fingerprintSchema,
  normalizeJsonSchema
} from "@/schemas/normalize";

/** The JSON Schema dialect requested from Standard JSON Schema converters. */
const target = "draft-2020-12";

/** Converts one side of a schema, or explains why it cannot. */
type SideConverter = (side: SchemaSide) => Result<SchemaConversion, SchemaConversionFailure>;

/**
 * Wraps a value returned by third-party conversion code into a conversion
 * result, rejecting anything that is not a plain JSON object.
 *
 * @param value - What the converter returned.
 * @param runtimeOnly - Runtime-only notes reported alongside the value.
 * @returns The conversion, or a failure when the value is not plain JSON.
 */
function checkedConversion(value: unknown, runtimeOnly: readonly string[]): Result<SchemaConversion, SchemaConversionFailure> {
  if (typeof value !== "object" || value === null || Array.isArray(value) || !isJsonValue(value))
    return err({ reason: "The converter returned a value that is not a plain JSON object." });
  return ok({ jsonSchema: value as JsonObject, runtimeOnly });
}

/**
 * Collects the normalized schemas of an application into a fingerprint-keyed
 * table and reports conversion problems as diagnostics.
 */
export class SchemaTable {
  /** Normalized schemas keyed by fingerprint. */
  readonly entries = new Map<string, ManifestSchema>();
  private readonly adapters: ReadonlyMap<string, SchemaAdapter>;
  private readonly diagnostics: CompilerDiagnostic[];
  /** Conversions by schema object, so a schema shared by a resource and its handler is converted and diagnosed once. */
  private readonly cache = new WeakMap<object, Promise<ManifestSchemaUse>>();

  /**
   * Creates an empty table that reports into a shared diagnostic list.
   *
   * @param adapters - Vendor-specific schema adapters; the first adapter for a vendor wins.
   * @param diagnostics - The list that conversion diagnostics are appended to.
   */
  constructor(adapters: readonly SchemaAdapter[], diagnostics: CompilerDiagnostic[]) {
    const byVendor = new Map<string, SchemaAdapter>();
    for (const adapter of adapters) {
      if (!byVendor.has(adapter.vendor))
        byVendor.set(adapter.vendor, adapter);
    }
    this.adapters = byVendor;
    this.diagnostics = diagnostics;
  }

  /**
   * Converts both sides of a schema, adds them to the table and returns the
   * manifest reference. A failure on the wire side (the side that crosses a
   * process boundary) is an error; a failure on the other side is a warning.
   *
   * @param schema - The Standard Schema to convert.
   * @param subject - What the schema belongs to, for diagnostics (for example `queue "orders" message`).
   * @param wire - Which side is serialized across the trust boundary.
   * @param location - Where the owning declaration lives, when known.
   * @returns The schema use, with `null` fingerprints for sides that cannot be represented.
   */
  async use(schema: StandardSchemaV1, subject: string, wire: SchemaSide, location?: DiagnosticLocation): Promise<ManifestSchemaUse> {
    const cached = this.cache.get(schema);
    if (cached !== undefined)
      return cached;
    const conversion = this.convert(schema, subject, wire, location);
    this.cache.set(schema, conversion);
    return conversion;
  }

  /**
   * Performs the uncached conversion behind {@link SchemaTable.use}.
   *
   * @param schema - The Standard Schema to convert.
   * @param subject - What the schema belongs to, for diagnostics.
   * @param wire - Which side is serialized across the trust boundary.
   * @param location - Where the owning declaration lives, when known.
   * @returns The schema use.
   */
  private async convert(schema: StandardSchemaV1, subject: string, wire: SchemaSide, location?: DiagnosticLocation): Promise<ManifestSchemaUse> {
    const vendor = schema["~standard"].vendor;
    const adapter = this.adapters.get(vendor);
    const at = location === undefined ? {} : { location };
    let convertSide: SideConverter;
    let converter: string;
    if (adapter !== undefined) {
      converter = `${vendor} adapter (${adapter.library})`;
      convertSide = side => adapter.convert(schema, side);
    } else if (hasStandardJsonSchema(schema)) {
      converter = `standard-json-schema (${vendor})`;
      convertSide = (side) => {
        try {
          return checkedConversion(schema["~standard"].jsonSchema[side]({ target }), []);
        } catch (error) {
          return err({ reason: error instanceof Error ? error.message : String(error) });
        }
      };
      this.diagnostics.push(experimentDiagnostic({
        code: experimentCodes.schemaFidelityUnverified,
        severity: "warning",
        message: `${subject}: converted with the generic Standard JSON Schema converter of "${vendor}", which cannot prove that the conversion is lossless.`,
        hint: `Register a schema adapter for "${vendor}" so that refinements and other runtime-only constraints are detected.`,
        ...at
      }));
    } else {
      this.diagnostics.push(experimentDiagnostic({
        code: experimentCodes.schemaUnsupported,
        severity: "error",
        message: `${subject}: no schema adapter is registered for vendor "${vendor}", and the schema does not implement Standard JSON Schema.`,
        hint: "Use a supported schema library or register an adapter.",
        ...at
      }));
      return { input: null, output: null, converter: `none (${vendor})`, fidelity: "unverified" };
    }

    const notes = new Set<string>();
    const fingerprints: Record<SchemaSide, string | null> = { input: null, output: null };
    for (const side of ["input", "output"] as const) {
      const conversion = convertSide(side);
      if (!conversion.ok) {
        this.diagnostics.push(experimentDiagnostic({
          code: experimentCodes.schemaUnsupported,
          severity: side === wire ? "error" : "warning",
          message: `${subject}: the ${side} side cannot be represented as JSON Schema: ${conversion.error.reason}`,
          ...at
        }));
        continue;
      }
      const jsonSchema = normalizeJsonSchema(conversion.value.jsonSchema);
      const runtimeOnly = [...new Set(conversion.value.runtimeOnly)].sort();
      for (const note of runtimeOnly)
        notes.add(note);
      const fingerprint = await fingerprintSchema(jsonSchema, runtimeOnly);
      this.entries.set(fingerprint, { jsonSchema, runtimeOnly });
      fingerprints[side] = fingerprint;
    }

    if (notes.size > 0) {
      this.diagnostics.push(experimentDiagnostic({
        code: experimentCodes.schemaUnsupported,
        severity: "warning",
        message: `${subject}: some constraints are enforced at runtime only and are absent from the portable schema: ${[...notes].sort().join("; ")}`,
        hint: "Generated clients and documentation will not show these constraints.",
        ...at
      }));
    }
    return { ...fingerprints, converter, fidelity: adapter === undefined ? "unverified" : "adapter" };
  }
}