import type {
  SchemaAdapter,
  SchemaSide,
  StandardSchemaV1
} from "@holqa/experiment-model";

import type { ConversionResult } from "@/internal/json-schema";

import { toJsonSchema } from "@valibot/to-json-schema";

import {
  cleanJsonSchema,
  converted,
  property,
  unsupported
} from "@/internal/json-schema";

/**
 * Valibot validation actions that `@valibot/to-json-schema` 1.8 converts. Any
 * other validation action (notably `check`) has no JSON Schema form; it is
 * excluded from conversion and reported as runtime-only instead of failing.
 */
const convertibleActions: ReadonlySet<string> = new Set([
  "base64",
  "bic",
  "decimal",
  "description",
  "digits",
  "email",
  "emoji",
  "empty",
  "ends_with",
  "entries",
  "examples",
  "gt_value",
  "hash",
  "hex_color",
  "hexadecimal",
  "includes",
  "integer",
  "iso_date",
  "iso_date_time",
  "iso_time",
  "iso_time_second",
  "iso_timestamp",
  "iso_week",
  "isrc",
  "jws_compact",
  "ksuid",
  "length",
  "lt_value",
  "mac",
  "max_entries",
  "max_length",
  "max_value",
  "metadata",
  "min_entries",
  "min_length",
  "min_value",
  "multiple_of",
  "nanoid",
  "non_empty",
  "not_value",
  "not_values",
  "octal",
  "regex",
  "rfc_email",
  "safe_integer",
  "slug",
  "starts_with",
  "title",
  "ulid",
  "url",
  "uuid",
  "value",
  "values"
]);

/**
 * Actions the converter maps to a JSON Schema keyword whose meaning differs
 * from what Valibot validates. They are converted, and the difference is reported.
 */
const inexactActions: Readonly<Record<string, string>> = {
  iso_date_time: "Valibot's isoDateTime accepts \"YYYY-MM-DDTHH:mm\" without seconds or offset, but the JSON Schema says format \"date-time\" (RFC 3339)"
};

/** Mutable state for one schema walk. */
interface WalkState {
  readonly side: SchemaSide;
  readonly runtimeOnly: string[];
  /** Validation action types to exclude from conversion. */
  readonly ignoredActions: Set<string>;
  readonly stack: Set<object>;
}

/**
 * Records what a schema's pipe enforces beyond what the converter can express.
 *
 * On the input side, conversion stops at the first transformation or second
 * schema, so later validations apply only at runtime. On the output side,
 * conversion starts at the last schema in the pipe.
 *
 * @param pipe - The schema's `pipe` array (the base schema first, then actions and schemas).
 * @param path - The JSON path of the schema.
 * @param state - Collects runtime-only findings and the first failure.
 */
function walkPipe(pipe: readonly unknown[], path: string, state: WalkState): void {
  const lastSchemaIndex = pipe.findLastIndex(item => property(item, "kind") === "schema");
  let described = true;
  pipe.forEach((item, index) => {
    if (index === 0)
      return;
    const kind = property(item, "kind");
    const type = String(property(item, "type"));
    if (state.side === "input" && (kind === "transformation" || kind === "schema")) {
      if (described)
        state.runtimeOnly.push(`${path}: input is transformed or re-validated after the described schema; later constraints are validated at runtime only`);
      described = false;
      return;
    }
    if (state.side === "output" && index < lastSchemaIndex)
      return;
    if (kind === "schema") {
      walk(item, path, state);
      return;
    }
    if (kind !== "validation" || !described)
      return;
    if (!convertibleActions.has(type)) {
      state.ignoredActions.add(type);
      state.runtimeOnly.push(`${path}: validation "${type}" is validated at runtime only`);
    }
    const inexact = inexactActions[type];
    if (inexact !== undefined)
      state.runtimeOnly.push(`${path}: ${inexact}`);
  });
}

/**
 * Walks a Valibot schema and records constructs the converter omits.
 *
 * @param schema - The Valibot schema (or a nested part of it).
 * @param path - The JSON path of `schema`, starting at `$`.
 * @param state - Collects runtime-only findings and the first failure.
 */
function walk(schema: unknown, path: string, state: WalkState): void {
  if (typeof schema !== "object" || schema === null || property(schema, "kind") !== "schema" || state.stack.has(schema))
    return;
  state.stack.add(schema);
  const pipe = property(schema, "pipe");
  if (Array.isArray(pipe))
    walkPipe(pipe, path, state);

  const entries = property(schema, "entries");
  if (typeof entries === "object" && entries !== null) {
    for (const key of Object.keys(entries)) {
      const entry = property(entries, key);
      walk(entry, `${path}.${key}`, state);
      if (state.side === "output" && property(entry, "type") === "optional" && property(entry, "default") !== undefined)
        state.runtimeOnly.push(`${path}.${key}: always present in output because of its default, but the converter marks it optional`);
    }
  }
  walk(property(schema, "item"), `${path}[*]`, state);
  walk(property(schema, "wrapped"), path, state);
  walk(property(schema, "rest"), `${path}.*`, state);
  walk(property(schema, "key"), `${path}{key}`, state);
  walk(property(schema, "value"), `${path}.*`, state);
  for (const field of ["items", "options"]) {
    const children = property(schema, field);
    if (Array.isArray(children))
      children.forEach((child, index) => walk(child, field === "items" ? `${path}[${index}]` : `${path}|${index}`, state));
  }
  const getter = property(schema, "getter");
  if (typeof getter === "function")
    walk((getter as (input: unknown) => unknown)(undefined), path, state);
  state.stack.delete(schema);
}

/**
 * Creates a Valibot adapter backed by `@valibot/to-json-schema`. Adapters may
 * import their own schema library; the model, SDK and compiler may not.
 *
 * @param options - Adapter settings.
 * @param options.version - The Valibot version recorded in manifests. Defaults to `1`.
 * @returns A schema adapter for the `valibot` vendor.
 */
export function createValibotAdapter(options: { readonly version?: string } = {}): SchemaAdapter {
  return Object.freeze({
    vendor: "valibot",
    library: `valibot@${options.version ?? "1"}`,
    convert: (schema: StandardSchemaV1, side: SchemaSide): ConversionResult => {
      const state: WalkState = { side, runtimeOnly: [], ignoredActions: new Set(), stack: new Set() };
      walk(schema, "$", state);
      try {
        const raw = toJsonSchema(schema as unknown as Parameters<typeof toJsonSchema>[0], {
          target: "draft-2020-12",
          typeMode: side,
          errorMode: "throw",
          ignoreActions: [...state.ignoredActions]
        });
        const jsonSchema = cleanJsonSchema(raw as Record<string, unknown>);
        if (typeof jsonSchema === "string")
          return unsupported(`$: ${jsonSchema}`);
        return converted(jsonSchema, state.runtimeOnly);
      } catch (error) {
        return unsupported(`$: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  });
}

/** The default Valibot 1 adapter. */
export const valibotAdapter: SchemaAdapter = createValibotAdapter();