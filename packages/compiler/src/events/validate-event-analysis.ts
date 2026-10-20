import type {
  Diagnostic,
  Result
} from "@holqa/core";

import type { EventAnalysis } from "@/events/event-analysis";

import {
  createDiagnostic,
  diagnosticCodes,
  err,
  ok,
  resourceKinds,
  triggerKinds
} from "@holqa/core";

/** Reads one untrusted value: returns a clean copy, or throws {@link Malformed} with the JSON path. */
type Reader<Value> = (value: unknown, path: string) => Value;

/** Thrown by readers for a value that does not have the expected shape. */
class Malformed extends Error {}

/**
 * Reads a string.
 *
 * @param value - The untrusted value.
 * @param path - Its JSON path, for messages.
 * @returns The string.
 * @throws {Malformed} When it is not a string.
 */
const text: Reader<string> = (value, path) => {
  if (typeof value !== "string")
    throw new Malformed(`${path} must be a string`);
  return value;
};

/**
 * Reads a positive safe integer.
 *
 * @param value - The untrusted value.
 * @param path - Its JSON path, for messages.
 * @returns The number.
 * @throws {Malformed} When it is not a positive safe integer.
 */
const positive: Reader<number> = (value, path) => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    throw new Malformed(`${path} must be a positive integer`);
  return value;
};

/**
 * Reads a boolean.
 *
 * @param value - The untrusted value.
 * @param path - Its JSON path, for messages.
 * @returns The boolean.
 * @throws {Malformed} When it is not a boolean.
 */
const flag: Reader<boolean> = (value, path) => {
  if (typeof value !== "boolean")
    throw new Malformed(`${path} must be a boolean`);
  return value;
};

/**
 * Builds a reader for one of several string constants.
 *
 * @param allowed - The accepted strings.
 * @returns The reader.
 */
function oneOf<const Value extends string>(allowed: readonly Value[]): Reader<Value> {
  return (value, path) => {
    if (typeof value !== "string" || !(allowed as readonly string[]).includes(value))
      throw new Malformed(`${path} must be one of ${allowed.join(", ")}`);
    return value as Value;
  };
}

/**
 * Builds a reader for a list.
 *
 * @param item - Reads each element.
 * @returns The reader.
 */
function list<Value>(item: Reader<Value>): Reader<Value[]> {
  return (value, path) => {
    if (!Array.isArray(value))
      throw new Malformed(`${path} must be a list`);
    return value.map((entry, index) => item(entry, `${path}[${index}]`));
  };
}

/** The readers of an object's fields; optional fields are marked with `optional`. */
type Fields = Readonly<Record<string, Reader<unknown> | { readonly optional: Reader<unknown> }>>;

/**
 * Builds a reader for an object with known fields. Unknown fields are
 * dropped; absent optional fields stay absent.
 *
 * @param fields - The field readers.
 * @returns The reader.
 */
function record<Value>(fields: Fields): Reader<Value> {
  return (value, path) => {
    if (typeof value !== "object" || value === null || Array.isArray(value))
      throw new Malformed(`${path} must be an object`);
    const source = value as Readonly<Record<string, unknown>>;
    const copy: Record<string, unknown> = {};
    for (const [name, field] of Object.entries(fields)) {
      const optional = typeof field === "object";
      if (optional && source[name] === undefined)
        continue;
      copy[name] = (optional ? field.optional : field)(source[name], `${path}.${name}`);
    }
    return copy as Value;
  };
}

/**
 * Builds a reader for objects discriminated by one field.
 *
 * @param key - The discriminating field.
 * @param variants - A reader per discriminant value.
 * @returns The reader.
 */
function variant<Value>(key: string, variants: Readonly<Record<string, Reader<unknown>>>): Reader<Value> {
  return (value, path) => {
    const tag = typeof value === "object" && value !== null ? (value as Readonly<Record<string, unknown>>)[key] : undefined;
    const reader = typeof tag === "string" && Object.hasOwn(variants, tag) ? variants[tag] : undefined;
    if (reader === undefined)
      throw new Malformed(`${path}.${key} must be one of ${Object.keys(variants).join(", ")}`);
    return reader(value, path) as Value;
  };
}

/** Reads a diagnostic location. */
const location = record({ file: text, line: { optional: positive }, column: { optional: positive } });

/** Reads a cycle allowance. */
const allowance = record({ justification: text });

/** Reads the fields every publication-like value has. */
const publicationFields = {
  operation: oneOf(["send", "put", "delete"]),
  origin: oneOf(["analysis", "declared"]),
  call: { optional: text },
  location: { optional: location },
  keyPrefix: { optional: text },
  keyExact: { optional: flag },
  via: { optional: list(text) }
} as const;

/** Reads the whole analysis. */
const analysis = record<EventAnalysis>({
  graph: record({
    nodes: list(variant("type", {
      resource: record({ key: text, type: oneOf(["resource"]), id: text, kind: oneOf(resourceKinds) }),
      handler: record({
        key: text,
        type: oneOf(["handler"]),
        id: text,
        trigger: oneOf(triggerKinds),
        coverage: oneOf(["complete", "partial", "unavailable"]),
        location: { optional: location },
        cycle: { optional: allowance },
        maxDepth: { optional: positive },
        maxPublications: { optional: positive }
      })
    })),
    edges: list(variant("relation", {
      consumes: record({ from: text, to: text, relation: oneOf(["consumes"]), event: oneOf(["queue.message", "object.created", "object.deleted", "schedule.tick", "http.request"]), prefix: { optional: text } }),
      publishes: record({ from: text, to: text, relation: oneOf(["publishes"]), certainty: oneOf(["known", "potential"]), ...publicationFields })
    })),
    unresolved: list(record({
      handler: text,
      certainty: oneOf(["known", "potential", "unknown"]),
      target: { optional: record({ kind: oneOf(["queue", "bucket"]), id: text }) },
      ...publicationFields
    }))
  }),
  cycles: list(record({
    status: oneOf(["reported", "allowed"]),
    certainty: oneOf(["known", "potential"]),
    handlers: list(text),
    path: list(record({ handler: text, resource: text, operation: oneOf(["send", "put", "delete"]), certainty: oneOf(["known", "potential"]), call: { optional: text }, location: { optional: location } })),
    allowedBy: { optional: list(record({ handler: text, justification: text })) }
  }))
});

/**
 * Validates an event analysis received from another process, such as the
 * CLI's analysis process (which ran application code and is not trusted).
 * Returns a copy with only the known fields.
 *
 * @param value - The parsed JSON value.
 * @returns The analysis, or one `HOLQA_ANALYSIS_FAILED` diagnostic naming the first malformed path.
 */
export function validateEventAnalysis(value: unknown): Result<EventAnalysis, Diagnostic[]> {
  try {
    return ok(analysis(value, "$"));
  } catch (error) {
    if (!(error instanceof Malformed))
      throw error;
    return err([createDiagnostic({ code: diagnosticCodes.analysisFailed, severity: "error", message: `The event analysis is malformed: ${error.message}.` })]);
  }
}