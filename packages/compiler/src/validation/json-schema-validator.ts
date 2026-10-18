import type {
  JsonObject,
  JsonValue
} from "@holqa/core";

/** One place where a value does not match a schema. */
export interface JsonSchemaViolation {
  /** JSON path of the offending value, for example `$.resources[0].kind`. */
  readonly path: string;
  readonly message: string;
}

/** The keywords this validator reads, typed for property access. */
interface SchemaRules {
  readonly $ref?: string;
  readonly $defs?: JsonObject;
  readonly type?: string;
  readonly const?: JsonValue;
  readonly enum?: readonly JsonValue[];
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: string;
  readonly minimum?: number;
  readonly items?: JsonValue;
  readonly minItems?: number;
  readonly uniqueItems?: boolean;
  readonly properties?: JsonObject;
  readonly required?: readonly string[];
  readonly additionalProperties?: JsonValue;
  readonly propertyNames?: JsonValue;
  readonly oneOf?: readonly JsonValue[];
}

/** Keywords that only annotate a schema and never affect validation. */
const annotations = new Set(["$schema", "$id", "$defs", "$comment", "title", "description"]);

/** Keywords this validator implements. Any other keyword is a programming error in the schema. */
const keywords = new Set([
  "$ref",
  "type",
  "const",
  "enum",
  "minLength",
  "maxLength",
  "pattern",
  "minimum",
  "items",
  "minItems",
  "uniqueItems",
  "properties",
  "required",
  "additionalProperties",
  "propertyNames",
  "oneOf"
]);

/**
 * Validates a value against a JSON Schema written with the small subset of
 * draft 2020-12 that Holqa's own document schemas use: `$ref` to local
 * `#/$defs/...`, `type`, `const`, `enum`, string, number and array bounds,
 * `properties`, `required`, `additionalProperties`, `propertyNames` and
 * `oneOf`. It exists so that the published manifest schema is executed by the
 * compiler's own reader rather than maintained as unchecked documentation.
 *
 * @param schema - The root schema, which also holds `$defs`.
 * @param value - The untrusted value.
 * @returns Every violation found; empty when the value is valid.
 * @throws {Error} When the schema uses an unsupported keyword or an unresolvable `$ref`, which is a bug in the schema.
 */
export function validateJsonSchema(schema: JsonObject, value: unknown): JsonSchemaViolation[] {
  const violations: JsonSchemaViolation[] = [];
  check(schema, value, "$", schema, violations);
  return violations;
}

/**
 * Checks one value against one (sub)schema and appends violations.
 *
 * @param schema - The subschema.
 * @param value - The value at `path`.
 * @param path - The JSON path of `value`.
 * @param root - The root schema, for `$ref` resolution.
 * @param out - Receives violations.
 */
function check(schema: JsonValue, value: unknown, path: string, root: JsonObject, out: JsonSchemaViolation[]): void {
  if (schema === true)
    return;
  if (schema === false || typeof schema !== "object" || schema === null || Array.isArray(schema)) {
    out.push({ path, message: "is not allowed" });
    return;
  }
  const rules = schema as SchemaRules;
  for (const keyword of Object.keys(rules)) {
    if (!keywords.has(keyword) && !annotations.has(keyword))
      throw new Error(`Unsupported JSON Schema keyword "${keyword}" at ${path}.`);
  }

  if (rules.$ref !== undefined)
    check(resolve(rules.$ref, root), value, path, root, out);
  if (rules.type !== undefined && !hasType(value, rules.type)) {
    out.push({ path, message: `must be of type ${rules.type}` });
    return;
  }
  if (rules.const !== undefined && !jsonEqual(rules.const, value))
    out.push({ path, message: `must be ${JSON.stringify(rules.const)}` });
  if (rules.enum !== undefined && !rules.enum.some(candidate => jsonEqual(candidate, value)))
    out.push({ path, message: `must be one of ${rules.enum.map(candidate => JSON.stringify(candidate)).join(", ")}` });
  if (typeof value === "string")
    checkString(rules, value, path, out);
  if (typeof value === "number" && rules.minimum !== undefined && value < rules.minimum)
    out.push({ path, message: `must be at least ${rules.minimum}` });
  if (Array.isArray(value))
    checkArray(rules, value, path, root, out);
  if (isPlainObject(value))
    checkObject(rules, value, path, root, out);
  if (rules.oneOf !== undefined)
    checkOneOf(rules.oneOf, value, path, root, out);
}

/**
 * Applies the string keywords.
 *
 * @param rules - The subschema.
 * @param value - The string being validated.
 * @param path - The JSON path of the value, reported in violations.
 * @param out - Receives violations.
 */
function checkString(rules: SchemaRules, value: string, path: string, out: JsonSchemaViolation[]): void {
  if (rules.minLength !== undefined && [...value].length < rules.minLength)
    out.push({ path, message: `must have at least ${rules.minLength} characters` });
  if (rules.maxLength !== undefined && [...value].length > rules.maxLength)
    out.push({ path, message: `must have at most ${rules.maxLength} characters` });
  if (rules.pattern !== undefined && !new RegExp(rules.pattern, "u").test(value))
    out.push({ path, message: `must match ${rules.pattern}` });
}

/**
 * Applies the array keywords.
 *
 * @param rules - The subschema.
 * @param value - The array being validated.
 * @param path - The JSON path of the value, reported in violations.
 * @param root - The root schema, for `$ref` resolution.
 * @param out - Receives violations.
 */
function checkArray(rules: SchemaRules, value: readonly unknown[], path: string, root: JsonObject, out: JsonSchemaViolation[]): void {
  if (rules.minItems !== undefined && value.length < rules.minItems)
    out.push({ path, message: `must have at least ${rules.minItems} items` });
  if (rules.uniqueItems === true && value.some((item, index) => value.findIndex(other => jsonEqual(other, item)) !== index))
    out.push({ path, message: "must not contain duplicate items" });
  const { items } = rules;
  if (items !== undefined)
    value.forEach((item, index) => check(items, item, `${path}[${index}]`, root, out));
}

/**
 * Applies the object keywords.
 *
 * @param rules - The subschema.
 * @param value - The object being validated.
 * @param path - The JSON path of the value, reported in violations.
 * @param root - The root schema, for `$ref` resolution.
 * @param out - Receives violations.
 */
function checkObject(rules: SchemaRules, value: Readonly<Record<string, unknown>>, path: string, root: JsonObject, out: JsonSchemaViolation[]): void {
  const properties = rules.properties ?? {};
  if (rules.required !== undefined) {
    for (const key of rules.required) {
      if (!Object.hasOwn(value, key))
        out.push({ path, message: `must have the property "${key}"` });
    }
  }
  for (const key of Object.keys(value)) {
    const child = `${path}${/^[a-z_$][\w$]*$/i.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`}`;
    if (rules.propertyNames !== undefined) {
      const before = out.length;
      check(rules.propertyNames, key, child, root, out);
      if (out.length > before)
        continue;
    }
    if (Object.hasOwn(properties, key))
      check(properties[key]!, value[key], child, root, out);
    else if (rules.additionalProperties === false)
      out.push({ path: child, message: "is not an allowed property" });
    else if (rules.additionalProperties !== undefined)
      check(rules.additionalProperties, value[key], child, root, out);
  }
}

/**
 * Applies `oneOf`. When no branch matches, the violations of the closest
 * branch (the one with the fewest) are reported, which for discriminated
 * unions is the branch whose discriminator matched.
 *
 * @param branches - The alternatives.
 * @param value - Any value being checked.
 * @param path - The JSON path of the value, reported in violations.
 * @param root - The root schema, for `$ref` resolution.
 * @param out - Receives violations.
 */
function checkOneOf(branches: readonly JsonValue[], value: unknown, path: string, root: JsonObject, out: JsonSchemaViolation[]): void {
  const results = branches.map((branch) => {
    const violations: JsonSchemaViolation[] = [];
    check(branch, value, path, root, violations);
    return violations;
  });
  const matches = results.filter(violations => violations.length === 0).length;
  if (matches === 1)
    return;
  if (matches > 1) {
    out.push({ path, message: "must match exactly one alternative, but matches several" });
    return;
  }
  const closest = results.reduce((best, violations) => violations.length < best.length ? violations : best);
  out.push(...closest);
}

/**
 * Resolves a local reference such as `#/$defs/resource`.
 *
 * @param reference - The `$ref` value.
 * @param root - The root schema, for `$ref` resolution.
 * @returns The referenced subschema.
 * @throws {Error} When the reference is not local or does not resolve.
 */
function resolve(reference: string, root: JsonObject): JsonValue {
  const match = /^#\/\$defs\/([\w-]+)$/.exec(reference);
  const definitions = (root as SchemaRules).$defs;
  const target = match === null ? undefined : definitions?.[match[1]!];
  if (target === undefined)
    throw new Error(`Unresolvable JSON Schema reference "${reference}".`);
  return target;
}

/**
 * Reports whether a value has a JSON Schema type.
 *
 * @param value - Any value being checked.
 * @param type - `object`, `array`, `string`, `integer`, `number`, `boolean` or `null`.
 * @returns `true` when the value has the type.
 */
function hasType(value: unknown, type: string): boolean {
  switch (type) {
    case "object": return isPlainObject(value);
    case "array": return Array.isArray(value);
    case "string": return typeof value === "string";
    case "integer": return typeof value === "number" && Number.isInteger(value);
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "boolean": return typeof value === "boolean";
    case "null": return value === null;
    default: throw new Error(`Unsupported JSON Schema type "${type}".`);
  }
}

/**
 * Reports whether a value is a non-array object.
 *
 * @param value - Any value being checked.
 * @returns `true` for plain objects.
 */
function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Compares two JSON values structurally, ignoring object key order.
 *
 * @param left - The first value.
 * @param right - The second value.
 * @returns `true` when both are the same JSON data.
 */
function jsonEqual(left: unknown, right: unknown): boolean {
  if (left === right)
    return true;
  if (Array.isArray(left) && Array.isArray(right))
    return left.length === right.length && left.every((item, index) => jsonEqual(item, right[index]));
  if (isPlainObject(left) && isPlainObject(right)) {
    const keys = Object.keys(left);
    return keys.length === Object.keys(right).length && keys.every(key => Object.hasOwn(right, key) && jsonEqual(left[key], right[key]));
  }
  return false;
}