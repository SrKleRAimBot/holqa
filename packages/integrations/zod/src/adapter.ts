import type {
  JsonObject,
  RuntimeOnlyConstraint,
  RuntimeOnlyKind,
  SchemaAdapter,
  SchemaConversionProblem,
  SchemaSide,
  SchemaSideConversion,
  StandardSchemaV1
} from "@holqa/core";
import type { $ZodType } from "zod/v4/core";

import {
  err,
  isJsonValue,
  ok
} from "@holqa/core";
import {
  toJSONSchema,
  version
} from "zod/v4/core";

/** The Standard Schema vendor name Zod reports. */
export const zodVendor = "zod";

/**
 * Zod check kinds that Zod's JSON Schema conversion represents faithfully.
 * Any other check (notably `custom`, produced by `.refine()`, `.superRefine()`
 * and `.check()`) is dropped silently by Zod and is reported as runtime-only.
 */
const representedChecks: ReadonlySet<string> = new Set([
  "min_length",
  "max_length",
  "length_equals",
  "string_format",
  "greater_than",
  "less_than",
  "multiple_of",
  "number_format"
]);

/** Zod definition types with a portable JSON description. Unknown types are rejected rather than guessed. */
const portableTypes: ReadonlySet<string> = new Set([
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
  "lazy"
]);

/** Zod types without a portable JSON description, with the reason and the portable alternative. */
const unrepresentableTypes: Readonly<Record<string, { readonly reason: string; readonly hint?: string }>> = {
  bigint: { reason: "BigInt values are not JSON data.", hint: "Use a string with a pattern, or z.int() for safe integers." },
  date: { reason: "Date objects are not JSON data.", hint: "Use z.iso.datetime(), or z.codec(z.iso.datetime(), z.date(), ...) to decode a Date on the output side." },
  symbol: { reason: "Symbols are not JSON data." },
  undefined: { reason: "undefined is not a JSON value.", hint: "Use .optional() on the property instead." },
  void: { reason: "void is not a JSON value." },
  nan: { reason: "NaN is not a JSON value." },
  map: { reason: "Map is not JSON data.", hint: "Use z.record()." },
  set: { reason: "Set is not JSON data.", hint: "Use z.array()." },
  function: { reason: "Functions are not JSON data." },
  custom: { reason: "z.custom() validates with an arbitrary function and has no portable description.", hint: "Describe the value with portable schemas, adding .refine() for extra rules." },
  // Zod's own converter describes z.promise(T) as T, which is wrong for a value that crosses a process boundary.
  promise: { reason: "Promises cannot cross an execution boundary." },
  // Zod's own converter describes z.file() as a binary string, but files cannot travel inside a JSON payload.
  file: { reason: "File objects cannot travel inside a JSON payload.", hint: "Send files through a bucket or a bytes payload codec." },
  success: { reason: "z.success() replaces the value with a boolean, which hides the validated shape." }
};

/** Mutable state for one schema walk. */
interface WalkState {
  readonly side: SchemaSide;
  readonly runtimeOnly: RuntimeOnlyConstraint[];
  /** Definitions on the current path; revisiting one means the schema is recursive. */
  readonly stack: Set<object>;
  problem: SchemaConversionProblem | undefined;
}

/** Settings for {@link createZodAdapter}. */
export interface ZodAdapterOptions {
  /** The library identifier recorded in contracts. Defaults to `zod@<installed version>`. */
  readonly library?: string | undefined;
}

/**
 * Creates a Zod 4 schema adapter. It converts with Zod's own JSON Schema
 * generator and walks Zod's internal definitions to report what that
 * generator would drop or misdescribe:
 *
 * - Refinements, value rewrites (`.trim()`), coercion, `.catch()`, preprocessing
 *   and piped second schemas become runtime-only constraints with their path.
 * - `Date`, `bigint`, `Map`, `Set`, `z.custom()`, promises, files and other
 *   non-JSON types fail with a problem and a hint.
 * - A transform's output side fails, because a function's result has no schema.
 * - Zod types the adapter does not know fail rather than being guessed.
 *
 * Zod classic (`zod`) and Zod Mini (`zod/mini`) schemas are both supported.
 *
 * @param options - Optional library identifier.
 * @returns An adapter for the `zod` vendor.
 * @throws {Error} When the installed Zod is not version 4.
 */
export function createZodAdapter(options: ZodAdapterOptions = {}): SchemaAdapter {
  if (version.major !== 4)
    throw new Error(`@holqa/zod supports Zod 4, but Zod ${version.major}.${version.minor}.${version.patch} is installed.`);
  return Object.freeze({
    vendor: zodVendor,
    library: options.library ?? `zod@${version.major}.${version.minor}.${version.patch}`,
    describe: (schema: StandardSchemaV1, side: SchemaSide) => describeZodSchema(schema, side)
  });
}

/** The default Zod 4 adapter. */
export const zodAdapter: SchemaAdapter = createZodAdapter();

/**
 * Reports whether a value is a Zod 4 schema: it has an internal `_zod.def`
 * object and reports the `zod` Standard Schema vendor.
 *
 * @param value - The value to inspect.
 * @returns `true` for Zod 4 schemas, classic or mini.
 * The check is structural: a value that imitates `_zod.def` passes, and
 * `toJSONSchema` failures are then reported as conversion problems.
 */
export function isZodSchema(value: unknown): value is StandardSchemaV1 & $ZodType {
  return definitionOf(value) !== undefined && property(property(value, "~standard"), "vendor") === zodVendor;
}

/**
 * Describes one side of a Zod schema.
 *
 * @param schema - The schema to describe.
 * @param side - The side to describe.
 * @returns The description, or the first problem found.
 */
function describeZodSchema(schema: StandardSchemaV1, side: SchemaSide): SchemaSideConversion {
  if (!isZodSchema(schema))
    return err({ path: "$", reason: "the value is not a Zod 4 schema." });
  const state: WalkState = { side, runtimeOnly: [], stack: new Set(), problem: undefined };
  walk(schema, "$", state);
  if (state.problem !== undefined)
    return err(state.problem);

  let raw: unknown;
  try {
    raw = toJSONSchema(schema, { target: "draft-2020-12", io: side, unrepresentable: "throw", cycles: "ref", reused: "inline" });
  } catch (error) {
    return err({ path: "$", reason: `Zod could not convert the schema: ${error instanceof Error ? error.message : String(error)}` });
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw) || !isJsonValue(raw))
    return err({ path: "$", reason: "Zod produced a JSON Schema that is not plain JSON data." });
  const { $schema: _dialect, ...jsonSchema } = raw as JsonObject;
  return ok({ jsonSchema, runtimeOnly: state.runtimeOnly });
}

/**
 * Walks a Zod schema and records constructs that Zod's JSON Schema output
 * would misrepresent or omit for the requested side.
 *
 * @param schema - The Zod schema, or a nested part of it.
 * @param path - The JSON path of `schema`, starting at `$`.
 * @param state - Collects runtime-only constraints and the first problem.
 */
function walk(schema: unknown, path: string, state: WalkState): void {
  if (state.problem !== undefined)
    return;
  const def = definitionOf(schema);
  if (def === undefined) {
    state.problem = { path, reason: "the value is not a Zod schema." };
    return;
  }
  if (state.stack.has(def))
    return;
  const type = property(def, "type");
  const unrepresentable = typeof type === "string" ? unrepresentableTypes[type] : undefined;
  if (unrepresentable !== undefined) {
    state.problem = { path, ...unrepresentable };
    return;
  }
  if (typeof type !== "string" || !portableTypes.has(type)) {
    state.problem = { path, reason: `@holqa/zod does not recognize the Zod type "${String(type)}".`, hint: "Report the type so the adapter can support it; until then, use a supported construct." };
    return;
  }

  state.stack.add(def);
  inspectChecks(def, path, state);
  if (property(def, "coerce") === true && state.side === "input")
    record(state, path, "coercion", "input is coerced, so values the JSON Schema rejects may be accepted");
  walkChildren(type, def, path, state);
  state.stack.delete(def);
}

/**
 * Walks the nested schemas of one definition.
 *
 * @param type - The definition's Zod type.
 * @param def - The definition.
 * @param path - Its JSON path.
 * @param state - Collects runtime-only constraints and the first problem.
 */
function walkChildren(type: string, def: object, path: string, state: WalkState): void {
  switch (type) {
    case "object": {
      const shape = property(def, "shape");
      if (typeof shape === "object" && shape !== null) {
        for (const key of Object.keys(shape))
          walk(property(shape, key), `${path}${formatKey(key)}`, state);
      }
      const catchall = property(def, "catchall");
      const catchallType = property(definitionOf(catchall), "type");
      if (catchall !== undefined && catchallType !== "never" && catchallType !== "unknown")
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
        options.forEach(option => walk(option, path, state));
      break;
    }
    case "intersection":
      walk(property(def, "left"), path, state);
      walk(property(def, "right"), path, state);
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
      walk(property(def, "innerType"), path, state);
      break;
    case "catch":
      if (state.side === "input")
        record(state, path, "fallback", "invalid input is replaced by a fallback value instead of being rejected");
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
        state.problem = { path, reason: "a transform's output is produced by a function and has no schema.", hint: "Pipe the transform into a schema (.pipe(z.number())) or accept that consumers' decoded type is not portable." };
      else
        record(state, path, "preprocess", "input passes through a function before it is validated");
      break;
    default:
      break;
  }
}

/**
 * Walks a Zod pipe (including codecs). The input side is described by the
 * pipe's first schema; constraints of the second schema then apply only at
 * runtime. A preprocessing pipe is described by its second schema instead.
 * The output side is described by the second schema.
 *
 * @param def - The pipe definition (`in`, `out`).
 * @param path - The JSON path of the pipe.
 * @param state - Receives the new constraint.
 */
function walkPipe(def: object, path: string, state: WalkState): void {
  const input = property(def, "in");
  const output = property(def, "out");
  if (state.side === "output") {
    walk(output, path, state);
    return;
  }
  // z.preprocess(fn, schema) pipes a transform into a schema. Zod then
  // describes the second schema, and the walk of the transform records the preprocessing.
  if (property(definitionOf(input), "type") === "transform") {
    walk(input, path, state);
    walk(output, path, state);
    return;
  }
  walk(input, path, state);
  const outputType = property(definitionOf(output), "type");
  const isCodec = property(def, "transform") !== undefined;
  if (outputType !== "transform" && !isCodec)
    record(state, path, "pipe", "a second schema validates the value after the described one");
}

/**
 * Records the checks attached to a definition that Zod's JSON Schema omits.
 *
 * @param def - A Zod definition.
 * @param path - The JSON path of the schema being walked.
 * @param state - The walk state.
 */
function inspectChecks(def: object, path: string, state: WalkState): void {
  const checks = property(def, "checks");
  if (!Array.isArray(checks))
    return;
  for (const check of checks) {
    const kind = property(definitionOf(check), "check");
    if (kind === "overwrite")
      record(state, path, "rewrite", "the value is rewritten during validation (for example .trim() or .toLowerCase())");
    else if (kind === "custom")
      record(state, path, "refinement", "a custom refinement is validated at runtime only");
    else if (typeof kind !== "string" || !representedChecks.has(kind))
      record(state, path, "check", `the Zod check "${String(kind)}" is validated at runtime only`);
  }
}

/**
 * Records one runtime-only constraint.
 *
 * @param state - The walk state.
 * @param path - The constrained path.
 * @param kind - Why the constraint is runtime-only.
 * @param detail - A human-readable description.
 */
function record(state: WalkState, path: string, kind: RuntimeOnlyKind, detail: string): void {
  state.runtimeOnly.push(Object.freeze({ path, kind, detail }));
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
 * Reads a property of an unknown value without trusting its type.
 *
 * @param value - Any value.
 * @param key - The property name.
 * @returns The property value, or `undefined` when `value` is not an object or lacks the property.
 */
function property(value: unknown, key: string): unknown {
  if ((typeof value !== "object" && typeof value !== "function") || value === null || !(key in value))
    return undefined;
  return (value as Record<string, unknown>)[key];
}

/**
 * Formats an object key as a JSON path segment: `.name` for identifier-like keys, `["a b"]` otherwise.
 *
 * @param key - The property name.
 * @returns The path segment.
 */
function formatKey(key: string): string {
  return /^[A-Z_$][\w$]*$/i.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`;
}