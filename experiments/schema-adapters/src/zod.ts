import type {
  SchemaAdapter,
  SchemaSide,
  StandardSchemaV1
} from "@holqa/experiment-model";

import type { ConversionResult } from "@/internal/json-schema";

import {
  converted,
  convertStandardJsonSchema,
  property,
  unsupported
} from "@/internal/json-schema";

/**
 * Zod check kinds that Zod's own JSON Schema conversion represents. Any other
 * check (notably `custom`, produced by `.refine()`, `.superRefine()` and
 * `.check()`) is dropped silently by Zod and must be reported here.
 */
const representedChecks: ReadonlySet<string> = new Set([
  "min_length",
  "max_length",
  "length_equals",
  "string_format",
  "greater_than",
  "less_than",
  "multiple_of",
  "number_format",
  "min_size",
  "max_size",
  "size_equals",
  "mime_type"
]);

/** Zod definition types this adapter understands. Unknown types fail instead of being guessed. */
const knownTypes: ReadonlySet<string> = new Set([
  "string",
  "number",
  "int",
  "boolean",
  "null",
  "any",
  "unknown",
  "never",
  "literal",
  "enum",
  "template_literal",
  "object",
  "array",
  "tuple",
  "union",
  "intersection",
  "record",
  "optional",
  "nullable",
  "default",
  "prefault",
  "nonoptional",
  "readonly",
  "catch",
  "pipe",
  "transform",
  "lazy",
  "success",
  // The following cannot be represented; Zod's converter throws for them,
  // and this adapter reports them explicitly as well.
  "bigint",
  "date",
  "symbol",
  "undefined",
  "void",
  "nan",
  "map",
  "set",
  "function",
  "custom",
  "promise",
  "file"
]);

/** Types that have no portable JSON representation, with the reason reported to the developer. */
const unrepresentableTypes: Readonly<Record<string, string>> = {
  bigint: "BigInt values are not JSON-serializable.",
  date: "Date objects are not JSON-serializable; use an ISO 8601 string (z.iso.datetime()) or a codec.",
  symbol: "Symbols are not JSON-serializable.",
  undefined: "undefined is not a JSON value.",
  void: "void is not a JSON value.",
  nan: "NaN is not a JSON value.",
  map: "Map is not JSON-serializable; use z.record().",
  set: "Set is not JSON-serializable; use z.array().",
  function: "Functions are not JSON-serializable.",
  custom: "z.custom() validates with an arbitrary function and has no portable description.",
  // Zod's converter describes z.promise(T) as T, which is wrong for a value that crosses a process boundary.
  promise: "Promises cannot cross a process boundary.",
  // Zod's converter describes z.file() as a binary string, but files cannot travel inside a JSON message.
  file: "File objects cannot travel inside a JSON message."
};

/** Mutable state for one schema walk. */
interface WalkState {
  readonly side: SchemaSide;
  readonly runtimeOnly: string[];
  /** Definitions on the current path; revisiting one means the schema is recursive. */
  readonly stack: Set<object>;
  failure: string | undefined;
}

/**
 * Returns a Zod schema's internal definition, or `undefined` for non-Zod values.
 *
 * @param schema - A possible Zod schema.
 * @returns The `_zod.def` object.
 */
function definitionOf(schema: unknown): object | undefined {
  const def = property(property(schema, "_zod"), "def");
  return typeof def === "object" && def !== null ? def : undefined;
}

/**
 * Records the checks attached to a definition that Zod's JSON Schema omits.
 *
 * @param def - A Zod definition.
 * @param path - The JSON path of the schema being walked.
 * @param state - The walk state to record into.
 */
function inspectChecks(def: object, path: string, state: WalkState): void {
  const checks = property(def, "checks");
  if (!Array.isArray(checks))
    return;
  for (const check of checks) {
    const kind = property(definitionOf(check), "check");
    if (kind === "overwrite")
      state.runtimeOnly.push(`${path}: value is rewritten during validation (for example trim or toLowerCase)`);
    else if (typeof kind !== "string" || !representedChecks.has(kind))
      state.runtimeOnly.push(`${path}: ${kind === "custom" ? "custom refinement" : `check "${String(kind)}"`} is validated at runtime only`);
  }
}

/**
 * Walks a Zod schema and records constructs that Zod's JSON Schema output
 * would misrepresent or omit for the requested side.
 *
 * @param schema - The Zod schema (or a nested part of it).
 * @param path - The JSON path of `schema`, starting at `$`.
 * @param state - Collects runtime-only findings and the first failure.
 */
function walk(schema: unknown, path: string, state: WalkState): void {
  if (state.failure !== undefined)
    return;
  const def = definitionOf(schema);
  if (def === undefined) {
    state.failure = `${path}: not a Zod schema.`;
    return;
  }
  if (state.stack.has(def))
    return;
  const type = property(def, "type");
  if (typeof type !== "string" || !knownTypes.has(type)) {
    state.failure = `${path}: the adapter does not recognize Zod type "${String(type)}".`;
    return;
  }
  const reason = unrepresentableTypes[type];
  if (reason !== undefined) {
    state.failure = `${path}: ${reason}`;
    return;
  }

  state.stack.add(def);
  inspectChecks(def, path, state);
  if (property(def, "coerce") === true && state.side === "input")
    state.runtimeOnly.push(`${path}: input is coerced, so values the JSON Schema rejects may be accepted`);

  switch (type) {
    case "object": {
      const shape = property(def, "shape");
      if (typeof shape === "object" && shape !== null) {
        for (const key of Object.keys(shape))
          walk(property(shape, key), `${path}.${key}`, state);
      }
      const catchall = property(def, "catchall");
      if (catchall !== undefined && property(definitionOf(catchall), "type") !== "never" && property(definitionOf(catchall), "type") !== "unknown")
        walk(catchall, `${path}.*`, state);
      break;
    }
    case "array":
      walk(property(def, "element"), `${path}[*]`, state);
      break;
    case "tuple": {
      const items = property(def, "items");
      if (Array.isArray(items))
        items.forEach((item, index) => walk(item, `${path}[${index}]`, state));
      const rest = property(def, "rest");
      if (rest !== undefined && rest !== null)
        walk(rest, `${path}[*]`, state);
      break;
    }
    case "union": {
      const options = property(def, "options");
      if (Array.isArray(options))
        options.forEach((option, index) => walk(option, `${path}|${index}`, state));
      break;
    }
    case "intersection":
      walk(property(def, "left"), `${path}&left`, state);
      walk(property(def, "right"), `${path}&right`, state);
      break;
    case "record":
      walk(property(def, "keyType"), `${path}{key}`, state);
      walk(property(def, "valueType"), `${path}.*`, state);
      break;
    case "optional":
    case "nullable":
    case "default":
    case "prefault":
    case "nonoptional":
    case "readonly":
    case "success":
      walk(property(def, "innerType"), path, state);
      break;
    case "catch":
      if (state.side === "input")
        state.runtimeOnly.push(`${path}: invalid input is replaced by a fallback value instead of being rejected`);
      walk(property(def, "innerType"), path, state);
      break;
    case "lazy": {
      const getter = property(def, "getter");
      if (typeof getter === "function")
        walk((getter as () => unknown)(), path, state);
      break;
    }
    case "pipe":
      walkPipe(def, path, state);
      break;
    case "transform":
      if (state.side === "output")
        state.failure = `${path}: a transform's output has no schema, so it cannot be described.`;
      else
        state.runtimeOnly.push(`${path}: input is preprocessed by a function before validation`);
      break;
    default:
      break;
  }
  state.stack.delete(def);
}

/**
 * Walks a Zod pipe. The input side is described by the pipe's first schema;
 * constraints of the second schema then apply only at runtime. The output side
 * is described by the second schema, which must not be a bare transform.
 *
 * @param def - The pipe definition (`in`, `out`).
 * @param path - The JSON path of the pipe.
 * @param state - Collects runtime-only findings and the first failure.
 */
function walkPipe(def: object, path: string, state: WalkState): void {
  const input = property(def, "in");
  const output = property(def, "out");
  const outputType = property(definitionOf(output), "type");
  if (state.side === "input") {
    walk(input, path, state);
    if (outputType !== "transform" && property(def, "transform") === undefined)
      state.runtimeOnly.push(`${path}: piped into a second schema whose constraints are validated at runtime only`);
    return;
  }
  walk(output, path, state);
}

/**
 * Creates a Zod adapter. It converts with Zod's built-in Standard JSON Schema
 * support and adds what that conversion silently omits, by walking Zod's
 * internal definitions structurally. It never imports Zod.
 *
 * @param options - Adapter settings.
 * @param options.version - The Zod version recorded in manifests. Defaults to `4`.
 * @returns A schema adapter for the `zod` vendor.
 */
export function createZodAdapter(options: { readonly version?: string } = {}): SchemaAdapter {
  return Object.freeze({
    vendor: "zod",
    library: `zod@${options.version ?? "4"}`,
    convert: (schema: StandardSchemaV1, side: SchemaSide): ConversionResult => {
      const state: WalkState = { side, runtimeOnly: [], stack: new Set(), failure: undefined };
      walk(schema, "$", state);
      if (state.failure !== undefined)
        return unsupported(state.failure);
      const jsonSchema = convertStandardJsonSchema(schema, side);
      if (typeof jsonSchema === "string")
        return unsupported(`$: ${jsonSchema}`);
      return converted(jsonSchema, state.runtimeOnly);
    }
  });
}

/** The default Zod 4 adapter. */
export const zodAdapter: SchemaAdapter = createZodAdapter();