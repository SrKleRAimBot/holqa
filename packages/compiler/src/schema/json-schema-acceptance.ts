import type { JsonValue } from "@holqa/core";

/**
 * A JSON Schema object with the keywords the checker reads spelled out, so
 * they can be accessed by name. Any other keyword is still reachable through
 * the index signature.
 */
interface SchemaNode {
  readonly [keyword: string]: JsonValue;
  readonly type?: JsonValue;
  readonly enum?: JsonValue;
  readonly const?: JsonValue;
  readonly properties?: JsonValue;
  readonly required?: JsonValue;
  readonly additionalProperties?: JsonValue;
  readonly items?: JsonValue;
  readonly prefixItems?: JsonValue;
  readonly minimum?: JsonValue;
  readonly maximum?: JsonValue;
  readonly multipleOf?: JsonValue;
  readonly pattern?: JsonValue;
  readonly format?: JsonValue;
  readonly anyOf?: JsonValue;
  readonly oneOf?: JsonValue;
}

/**
 * How sure the checker is that a reader rejects values a writer accepts.
 *
 * - `definite`: such values exist.
 * - `possible`: such values may exist (for example, two different regular expressions).
 * - `unknown`: the schemas use constructs the checker does not analyze.
 */
export type AcceptanceCertainty = "definite" | "possible" | "unknown";

/**
 * What kind of narrowing a finding describes, from the reader's point of view
 * relative to the writer: the reader is narrower than the writer in this way.
 */
export type NarrowingKind
  = | "type-narrowed"
    | "value-restricted"
    | "enum-value-removed"
    | "constraint-tightened"
    | "pattern-changed"
    | "format-changed"
    | "required-property-added"
    | "optional-became-required"
    | "property-removed"
    | "additional-properties-restricted"
    | "value-rejected"
    | "unsupported-keyword";

/** One way in which a reader schema may reject values a writer schema accepts. */
export interface AcceptanceFinding {
  /** JSON path of the affected value, for example `$.lines[*].sku`. */
  readonly path: string;
  readonly kind: NarrowingKind;
  readonly certainty: AcceptanceCertainty;
  /** The reader's relevant constraint, rendered as text, when there is one. */
  readonly reader?: string;
  /** The writer's relevant constraint, rendered as text, when there is one. */
  readonly writer?: string;
}

/** Keywords that only annotate and never change which values are accepted. */
const annotationKeywords: ReadonlySet<string> = new Set([
  "$schema",
  "$id",
  "$anchor",
  "$comment",
  "title",
  "description",
  "examples",
  "default",
  "deprecated",
  "readOnly",
  "writeOnly",
  "contentEncoding",
  "contentMediaType"
]);

/** Keywords the checker analyzes. */
const analyzedKeywords: ReadonlySet<string> = new Set([
  "type",
  "enum",
  "const",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "prefixItems",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "pattern",
  "format",
  "minItems",
  "maxItems",
  "anyOf",
  "oneOf"
]);

/**
 * Keywords the checker does not analyze but which only ever narrow a schema,
 * so a writer may use them freely: a narrower writer never hurts the reader.
 */
const writerNarrowingKeywords: ReadonlySet<string> = new Set([
  "uniqueItems",
  "minProperties",
  "maxProperties",
  "dependentRequired",
  "contains",
  "minContains",
  "maxContains",
  "propertyNames",
  "not"
]);

/** Certainty ranks used to pick the most accepting union member. */
const certaintyRank: Readonly<Record<AcceptanceCertainty, number>> = { possible: 1, unknown: 2, definite: 3 };

/**
 * Finds values that `writer` accepts but `reader` may reject. Both schemas
 * must be canonical JSON Schemas (draft 2020-12). An empty result means every
 * value the writer accepts is also accepted by the reader, as far as the
 * analyzed keywords show.
 *
 * Assumption: producers send only declared properties. A property the reader
 * adds as optional is therefore not reported, even when the writer would have
 * allowed undeclared properties.
 *
 * @param reader - The schema that validates received data.
 * @param writer - The schema that data was produced under.
 * @returns The findings, in schema order.
 */
export function findRejections(reader: JsonValue, writer: JsonValue): AcceptanceFinding[] {
  const findings: AcceptanceFinding[] = [];
  compare(reader, writer, "$", findings);
  return findings;
}

/**
 * Compares one pair of subschemas and records findings.
 *
 * @param reader - The reading subschema.
 * @param writer - The writing subschema.
 * @param path - The JSON path of the pair.
 * @param out - Collects findings.
 */
function compare(reader: JsonValue, writer: JsonValue, path: string, out: AcceptanceFinding[]): void {
  if (writer === false || reader === true || deepEqual(reader, writer))
    return;
  if (!isObject(reader)) {
    out.push({ path, kind: "value-rejected", certainty: reader === false ? "definite" : "unknown" });
    return;
  }
  if (Object.keys(reader).every(keyword => annotationKeywords.has(keyword)))
    return;
  const writerSchema: SchemaNode = isObject(writer) ? writer : {};

  if (hasBothUnionKeywords(reader) || hasBothUnionKeywords(writerSchema)) {
    out.push({ path, kind: "unsupported-keyword", certainty: "unknown", reader: "anyOf with oneOf" });
    return;
  }
  const opaque = opaqueDifference(reader, writerSchema);
  if (opaque !== undefined) {
    out.push({ path, kind: "unsupported-keyword", certainty: "unknown", reader: opaque });
    return;
  }

  const writerMembers = unionMembers(writerSchema);
  if (writerMembers !== undefined) {
    const siblings = withoutUnion(writerSchema);
    for (const member of writerMembers)
      compare(reader, merge(siblings, member), path, out);
    return;
  }
  const readerMembers = unionMembers(reader);
  if (readerMembers !== undefined) {
    const siblings = withoutUnion(reader);
    const exclusive = reader.oneOf !== undefined;
    for (const part of splitByType(writerSchema))
      compareAgainstUnion(readerMembers.map(member => merge(siblings, member)), part, path, exclusive, out);
    return;
  }

  compareNode(reader, writerSchema, path, out);
}

/**
 * Compares a writer against a reader union: the writer is accepted when one
 * member accepts it. Reports the findings of the most accepting member. For
 * `oneOf`, a value matching two members is rejected; unless every pair of
 * members is provably disjoint, that is reported as possible.
 *
 * @param members - The reader's union members.
 * @param writer - The writing subschema.
 * @param path - The JSON path.
 * @param exclusive - Whether the union is a `oneOf`.
 * @param out - Collects findings.
 */
function compareAgainstUnion(members: readonly JsonValue[], writer: SchemaNode, path: string, exclusive: boolean, out: AcceptanceFinding[]): void {
  let best: AcceptanceFinding[] | undefined;
  let bestRank = Number.POSITIVE_INFINITY;
  for (const member of members) {
    const findings: AcceptanceFinding[] = [];
    compare(member, writer, path, findings);
    const rank = Math.max(0, ...findings.map(finding => certaintyRank[finding.certainty]));
    if (rank < bestRank) {
      best = findings;
      bestRank = rank;
    }
  }
  if (exclusive && !pairwiseDisjoint(members)) {
    out.push({ path, kind: "value-rejected", certainty: "possible", reader: "oneOf with overlapping members" });
    return;
  }
  out.push(...(best ?? [{ path, kind: "value-rejected" as const, certainty: "definite" as const }]));
}

/**
 * Compares two non-union subschemas keyword by keyword.
 *
 * @param reader - The reading subschema.
 * @param writer - The writing subschema.
 * @param path - The JSON path.
 * @param out - Collects findings.
 */
function compareNode(reader: SchemaNode, writer: SchemaNode, path: string, out: AcceptanceFinding[]): void {
  const readerTypes = declaredTypes(reader);
  const writerTypes = declaredTypes(writer);
  if (readerTypes !== undefined) {
    if (writerTypes === undefined) {
      out.push({ path, kind: "type-narrowed", certainty: "definite", reader: [...readerTypes].join(" | "), writer: "any" });
      return;
    }
    const missing = [...writerTypes].filter(type => !acceptsType(readerTypes, type));
    if (missing.length > 0)
      out.push({ path, kind: "type-narrowed", certainty: "definite", reader: [...readerTypes].join(" | "), writer: [...writerTypes].join(" | ") });
    if (missing.length === writerTypes.size)
      return;
  }

  const readerValues = enumValues(reader);
  const writerValues = enumValues(writer);
  if (readerValues !== undefined) {
    if (writerValues === undefined) {
      out.push({ path, kind: "value-restricted", certainty: "definite", reader: renderValues(readerValues) });
      return;
    }
    const removed = writerValues.filter(value => !readerValues.some(candidate => deepEqual(candidate, value)));
    if (removed.length > 0)
      out.push({ path, kind: "enum-value-removed", certainty: "definite", reader: renderValues(readerValues), writer: renderValues(writerValues) });
    return;
  }
  if (writerValues !== undefined) {
    compareValues(reader, writerValues, path, out);
    return;
  }

  const types = writerTypes ?? new Set(["null", "boolean", "number", "integer", "string", "array", "object"]);
  if (types.has("number") || types.has("integer"))
    compareNumbers(reader, writer, path, out);
  if (types.has("string"))
    compareStrings(reader, writer, path, out);
  if (types.has("array"))
    compareArrays(reader, writer, path, out);
  if (types.has("object"))
    compareObjects(reader, writer, path, out);
}

/**
 * Checks a writer's finite set of values (`enum` or `const`) against the
 * reader's scalar constraints.
 *
 * @param reader - The reading subschema, which has no `enum` or `const`.
 * @param values - Every value the writer accepts.
 * @param path - The JSON path.
 * @param out - Collects findings.
 */
function compareValues(reader: SchemaNode, values: readonly JsonValue[], path: string, out: AcceptanceFinding[]): void {
  for (const value of values) {
    if (typeof value === "object" && value !== null) {
      // Object and array values would need full validation against the reader; the checker does not do that.
      out.push({ path, kind: "unsupported-keyword", certainty: "unknown", reader: "enum or const with object or array values" });
      return;
    }
    if (typeof value === "number")
      compareNumbers(reader, { minimum: value, maximum: value }, path, out);
    else if (typeof value === "string")
      compareStrings(reader, { minLength: value.length, maxLength: value.length, const: value }, path, out);
  }
}

/**
 * Compares numeric bounds and `multipleOf`.
 *
 * @param reader - The reading subschema.
 * @param writer - The writing subschema.
 * @param path - The JSON path.
 * @param out - Collects findings.
 */
function compareNumbers(reader: SchemaNode, writer: SchemaNode, path: string, out: AcceptanceFinding[]): void {
  const lowerReader = bound(reader, "minimum", "exclusiveMinimum", 1);
  const lowerWriter = bound(writer, "minimum", "exclusiveMinimum", 1);
  if (lowerReader !== undefined && (lowerWriter === undefined || lowerWriter.value < lowerReader.value || (lowerWriter.value === lowerReader.value && lowerReader.exclusive && !lowerWriter.exclusive)))
    out.push({ path, kind: "constraint-tightened", certainty: "definite", reader: renderBound(">", lowerReader), writer: lowerWriter === undefined ? "none" : renderBound(">", lowerWriter) });
  const upperReader = bound(reader, "maximum", "exclusiveMaximum", -1);
  const upperWriter = bound(writer, "maximum", "exclusiveMaximum", -1);
  if (upperReader !== undefined && (upperWriter === undefined || upperWriter.value > upperReader.value || (upperWriter.value === upperReader.value && upperReader.exclusive && !upperWriter.exclusive)))
    out.push({ path, kind: "constraint-tightened", certainty: "definite", reader: renderBound("<", upperReader), writer: upperWriter === undefined ? "none" : renderBound("<", upperWriter) });

  const divisor = reader.multipleOf;
  if (typeof divisor === "number") {
    const writerDivisor = writer.multipleOf;
    const integerWriter = declaredTypes(writer)?.has("integer") === true && !declaredTypes(writer)?.has("number");
    const accepted = typeof writerDivisor === "number"
      ? Number.isInteger(writerDivisor / divisor)
      : (integerWriter && Number.isInteger(1 / divisor)) || (writer.minimum !== undefined && writer.minimum === writer.maximum && Number.isInteger(Number(writer.minimum) / divisor));
    if (!accepted)
      out.push({ path, kind: "constraint-tightened", certainty: "definite", reader: `multipleOf ${divisor}`, writer: typeof writerDivisor === "number" ? `multipleOf ${writerDivisor}` : "none" });
  }
}

/**
 * Compares string length, `pattern` and `format`.
 *
 * @param reader - The reading subschema.
 * @param writer - The writing subschema.
 * @param path - The JSON path.
 * @param out - Collects findings.
 */
function compareStrings(reader: SchemaNode, writer: SchemaNode, path: string, out: AcceptanceFinding[]): void {
  compareCounts(reader, writer, "minLength", "maxLength", path, out);
  const pattern = reader.pattern;
  if (typeof pattern === "string" && writer.pattern !== pattern) {
    const literal = writer.const;
    if (typeof literal === "string" && isValidPattern(pattern)) {
      if (!new RegExp(pattern, "u").test(literal))
        out.push({ path, kind: "pattern-changed", certainty: "definite", reader: pattern, writer: JSON.stringify(literal) });
    } else {
      const writerPattern = writer.pattern;
      out.push({ path, kind: "pattern-changed", certainty: writerPattern === undefined ? "definite" : "possible", reader: pattern, writer: typeof writerPattern === "string" ? writerPattern : "none" });
    }
  }
  const format = reader.format;
  if (typeof format === "string" && writer.format !== format && writer.const === undefined) {
    const writerFormat = writer.format;
    out.push({ path, kind: "format-changed", certainty: writerFormat === undefined ? "definite" : "possible", reader: format, writer: typeof writerFormat === "string" ? writerFormat : "none" });
  }
}

/**
 * Compares array lengths and element schemas, including tuple positions.
 *
 * @param reader - The reading subschema.
 * @param writer - The writing subschema.
 * @param path - The JSON path.
 * @param out - Collects findings.
 */
function compareArrays(reader: SchemaNode, writer: SchemaNode, path: string, out: AcceptanceFinding[]): void {
  compareCounts(reader, writer, "minItems", "maxItems", path, out);
  const readerPrefix = schemaList(reader.prefixItems);
  const writerPrefix = schemaList(writer.prefixItems);
  const readerItems = reader.items ?? true;
  const writerItems = writer.items ?? true;
  const positions = Math.max(readerPrefix.length, writerPrefix.length);
  for (let index = 0; index < positions; index++)
    compare(readerPrefix[index] ?? readerItems, writerPrefix[index] ?? writerItems, `${path}[${index}]`, out);
  compare(readerItems, writerItems, `${path}[*]`, out);
}

/**
 * Compares required properties, declared properties and additional properties.
 *
 * @param reader - The reading subschema.
 * @param writer - The writing subschema.
 * @param path - The JSON path.
 * @param out - Collects findings.
 */
function compareObjects(reader: SchemaNode, writer: SchemaNode, path: string, out: AcceptanceFinding[]): void {
  const readerRequired = stringSet(reader.required);
  const writerRequired = stringSet(writer.required);
  const readerProperties = isObject(reader.properties) ? reader.properties : {};
  const writerProperties = isObject(writer.properties) ? writer.properties : {};
  const readerAdditional = reader.additionalProperties;
  const writerAdditional = writer.additionalProperties;

  for (const name of readerRequired) {
    if (!writerRequired.has(name))
      out.push({ path: `${path}${formatKey(name)}`, kind: name in writerProperties ? "optional-became-required" : "required-property-added", certainty: "definite" });
  }
  for (const [name, writerProperty] of Object.entries(writerProperties)) {
    const propertyPath = `${path}${formatKey(name)}`;
    const readerProperty = readerProperties[name];
    if (readerProperty !== undefined)
      compare(readerProperty, writerProperty, propertyPath, out);
    else if (readerAdditional === false)
      out.push({ path: propertyPath, kind: "property-removed", certainty: "definite" });
    else if (readerAdditional !== undefined)
      compare(readerAdditional, writerProperty, propertyPath, out);
  }
  if (isObject(writerAdditional)) {
    // A record-like writer may send any key with its additional-properties schema, including keys the reader now declares.
    for (const [name, readerProperty] of Object.entries(readerProperties)) {
      if (!(name in writerProperties))
        compare(readerProperty, writerAdditional, `${path}${formatKey(name)}`, out);
    }
  }

  if (readerAdditional === undefined || readerAdditional === true || writerAdditional === false)
    return;
  if (writerAdditional === undefined || writerAdditional === true) {
    // Producers are assumed to send only declared properties, so this is possible rather than definite.
    out.push({ path: `${path}.*`, kind: "additional-properties-restricted", certainty: "possible" });
    return;
  }
  compare(readerAdditional, writerAdditional, `${path}.*`, out);
}

/**
 * Compares a lower and an upper count, such as `minLength` and `maxLength`.
 *
 * @param reader - The reading subschema.
 * @param writer - The writing subschema.
 * @param minimumKeyword - The lower-bound keyword.
 * @param maximumKeyword - The upper-bound keyword.
 * @param path - The JSON path.
 * @param out - Collects findings.
 */
function compareCounts(reader: SchemaNode, writer: SchemaNode, minimumKeyword: string, maximumKeyword: string, path: string, out: AcceptanceFinding[]): void {
  const readerMinimum = reader[minimumKeyword];
  const writerMinimum = writer[minimumKeyword];
  if (typeof readerMinimum === "number" && readerMinimum > (typeof writerMinimum === "number" ? writerMinimum : 0))
    out.push({ path, kind: "constraint-tightened", certainty: "definite", reader: `${minimumKeyword} ${readerMinimum}`, writer: typeof writerMinimum === "number" ? `${minimumKeyword} ${writerMinimum}` : "none" });
  const readerMaximum = reader[maximumKeyword];
  const writerMaximum = writer[maximumKeyword];
  if (typeof readerMaximum === "number" && (typeof writerMaximum !== "number" || writerMaximum > readerMaximum))
    out.push({ path, kind: "constraint-tightened", certainty: "definite", reader: `${maximumKeyword} ${readerMaximum}`, writer: typeof writerMaximum === "number" ? `${maximumKeyword} ${writerMaximum}` : "none" });
}

/**
 * Finds the first keyword that the checker cannot analyze and that differs in
 * a way that may matter: any such keyword on the reader, or a shape-changing
 * one (`$ref`, `allOf`, `if`, ...) on the writer.
 *
 * @param reader - The reading subschema.
 * @param writer - The writing subschema.
 * @returns The keyword, or `undefined` when every difference is analyzable.
 */
function opaqueDifference(reader: SchemaNode, writer: SchemaNode): string | undefined {
  const keywords = [...new Set([...Object.keys(reader), ...Object.keys(writer)])].sort();
  return keywords.find((keyword) => {
    if (annotationKeywords.has(keyword) || analyzedKeywords.has(keyword) || deepEqual(reader[keyword], writer[keyword]))
      return false;
    return keyword in reader || !writerNarrowingKeywords.has(keyword);
  });
}

/**
 * Returns the members of a schema's `anyOf` or `oneOf`.
 *
 * @param schema - The subschema.
 * @returns The members, or `undefined` when the schema is not a union.
 */
function unionMembers(schema: SchemaNode): readonly JsonValue[] | undefined {
  const members = schema.anyOf ?? schema.oneOf;
  return Array.isArray(members) ? members : undefined;
}

/**
 * Reports whether no value can match two of the given schemas, as far as
 * types and `const`/`enum` values (including those of required properties,
 * such as discriminators) prove.
 *
 * @param members - The union members.
 * @returns `true` when every pair is provably disjoint.
 */
function pairwiseDisjoint(members: readonly JsonValue[]): boolean {
  return members.every((left, index) => members.slice(index + 1).every(right => provablyDisjoint(left, right)));
}

/**
 * Proves that two schemas accept no common value, by type, by enumerated
 * values, or by a required property whose schemas are provably disjoint.
 *
 * @param left - One schema.
 * @param right - The other schema.
 * @returns `true` when disjointness is proven; `false` means "maybe overlapping".
 */
function provablyDisjoint(left: JsonValue, right: JsonValue): boolean {
  if (left === false || right === false)
    return true;
  if (!isObject(left) || !isObject(right))
    return false;
  const leftTypes = declaredTypes(left);
  const rightTypes = declaredTypes(right);
  if (leftTypes !== undefined && rightTypes !== undefined && ![...leftTypes].some(type => [...rightTypes].some(other => typesOverlap(type, other))))
    return true;
  const leftValues = enumValues(left);
  const rightValues = enumValues(right);
  if (leftValues !== undefined && rightValues !== undefined && !leftValues.some(value => rightValues.some(other => deepEqual(value, other))))
    return true;
  const leftProperties = isObject(left.properties) ? left.properties : {};
  const rightProperties = isObject(right.properties) ? right.properties : {};
  const shared = [...stringSet(left.required)].filter(name => stringSet(right.required).has(name));
  return shared.some(name => leftProperties[name] !== undefined && rightProperties[name] !== undefined && provablyDisjoint(leftProperties[name], rightProperties[name]));
}

/**
 * Reports whether two JSON Schema types share values; `integer` is part of `number`.
 *
 * @param left - One type name.
 * @param right - The other type name.
 * @returns `true` when some value has both types.
 */
function typesOverlap(left: string, right: string): boolean {
  return left === right || (left === "integer" && right === "number") || (left === "number" && right === "integer");
}

/**
 * Reports whether a schema uses `anyOf` and `oneOf` together, which the checker does not combine.
 *
 * @param schema - The subschema.
 * @returns `true` when both keywords are present.
 */
function hasBothUnionKeywords(schema: SchemaNode): boolean {
  return schema.anyOf !== undefined && schema.oneOf !== undefined;
}

/**
 * Removes the union keywords from a schema, keeping the constraints that apply to every member.
 *
 * @param schema - A schema with `anyOf` or `oneOf`.
 * @returns The sibling keywords.
 */
function withoutUnion(schema: SchemaNode): SchemaNode {
  const { anyOf: _anyOf, oneOf: _oneOf, ...siblings } = schema;
  return siblings;
}

/**
 * Combines a union's sibling keywords with one member. Member keywords win;
 * canonical union schemas rarely repeat keywords on both levels.
 *
 * @param siblings - The keywords next to the union.
 * @param member - One union member.
 * @returns The combined subschema.
 */
function merge(siblings: SchemaNode, member: JsonValue): JsonValue {
  if (Object.keys(siblings).length === 0 || !isObject(member))
    return member;
  return { ...siblings, ...member };
}

/**
 * Splits a writer with several types into one schema per type, so that each
 * can be matched against a different reader union member.
 *
 * @param writer - The writing subschema.
 * @returns One schema per declared type, or the writer itself.
 */
function splitByType(writer: SchemaNode): SchemaNode[] {
  const type = writer.type;
  if (!Array.isArray(type) || type.length < 2 || enumValues(writer) !== undefined)
    return [writer];
  return type.map(entry => ({ ...writer, type: entry }));
}

/**
 * Returns the JSON types a subschema accepts, from `type` or from its `enum`/`const` values.
 *
 * @param schema - The subschema.
 * @returns The types, or `undefined` when any type is accepted.
 */
function declaredTypes(schema: SchemaNode): ReadonlySet<string> | undefined {
  const type = schema.type;
  if (typeof type === "string")
    return new Set([type]);
  if (Array.isArray(type))
    return new Set(type.filter(entry => typeof entry === "string"));
  const values = enumValues(schema);
  return values === undefined ? undefined : new Set(values.map(jsonType));
}

/**
 * Reports whether a set of reader types accepts a writer type; `number` includes `integer`.
 *
 * @param readerTypes - Every type the reader accepts.
 * @param type - One writer type.
 * @returns `true` when the type is accepted.
 */
function acceptsType(readerTypes: ReadonlySet<string>, type: string): boolean {
  return readerTypes.has(type) || (type === "integer" && readerTypes.has("number"));
}

/**
 * Returns the finite set of values a subschema allows through `enum` or `const`.
 *
 * @param schema - The subschema.
 * @returns The values, or `undefined` when the schema does not enumerate them.
 */
function enumValues(schema: SchemaNode): readonly JsonValue[] | undefined {
  if ("const" in schema && schema.const !== undefined)
    return [schema.const];
  const values = schema.enum;
  return Array.isArray(values) ? values : undefined;
}

/**
 * Returns the JSON Schema type of a JSON value; whole numbers are `integer`.
 *
 * @param value - Any JSON value.
 * @returns Its type name.
 */
function jsonType(value: JsonValue): string {
  if (value === null)
    return "null";
  if (Array.isArray(value))
    return "array";
  if (typeof value === "number")
    return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

/**
 * Reads the effective lower or upper bound from an inclusive and an exclusive keyword.
 *
 * @param schema - The subschema.
 * @param inclusiveKeyword - `minimum` or `maximum`.
 * @param exclusiveKeyword - `exclusiveMinimum` or `exclusiveMaximum`.
 * @param direction - `1` for lower bounds (larger is tighter), `-1` for upper bounds.
 * @returns The tighter bound, or `undefined` when there is none.
 */
function bound(schema: SchemaNode, inclusiveKeyword: string, exclusiveKeyword: string, direction: 1 | -1): { value: number; exclusive: boolean } | undefined {
  const inclusive = schema[inclusiveKeyword];
  const exclusive = schema[exclusiveKeyword];
  const candidates = [
    ...(typeof inclusive === "number" ? [{ value: inclusive, exclusive: false }] : []),
    ...(typeof exclusive === "number" ? [{ value: exclusive, exclusive: true }] : [])
  ];
  return candidates.reduce<{ value: number; exclusive: boolean } | undefined>((tightest, candidate) => {
    if (tightest === undefined)
      return candidate;
    const difference = (candidate.value - tightest.value) * direction;
    return difference > 0 || (difference === 0 && candidate.exclusive) ? candidate : tightest;
  }, undefined);
}

/**
 * Renders a bound such as `>= 1` or `< 10`.
 *
 * @param comparison - `>` for lower bounds, `<` for upper bounds.
 * @param limit - The bound to render.
 * @param limit.value - The number compared against.
 * @param limit.exclusive - Whether the bound itself is excluded.
 * @returns The rendered bound.
 */
function renderBound(comparison: ">" | "<", limit: { value: number; exclusive: boolean }): string {
  return `${comparison}${limit.exclusive ? "" : "="} ${limit.value}`;
}

/**
 * Renders a list of values as compact JSON, for messages.
 *
 * @param values - The enumerated values to render.
 * @returns Text such as `"normal" | "urgent"`.
 */
function renderValues(values: readonly JsonValue[]): string {
  return values.map(value => JSON.stringify(value)).join(" | ");
}

/**
 * Reads a list of subschemas, ignoring malformed values.
 *
 * @param value - A keyword value.
 * @returns The list, or an empty list.
 */
function schemaList(value: JsonValue | undefined): readonly JsonValue[] {
  return Array.isArray(value) ? value : [];
}

/**
 * Reads a list of strings as a set, ignoring malformed values.
 *
 * @param value - A keyword value such as `required`.
 * @returns The strings.
 */
function stringSet(value: JsonValue | undefined): ReadonlySet<string> {
  return new Set(Array.isArray(value) ? value.filter(entry => typeof entry === "string") : []);
}

/**
 * Reports whether a regular expression compiles with the `u` flag.
 *
 * @param pattern - The pattern source.
 * @returns `true` when it compiles.
 */
function isValidPattern(pattern: string): boolean {
  try {
    void new RegExp(pattern, "u");
    return true;
  } catch {
    return false;
  }
}

/**
 * Formats an object key as a JSON path segment: `.name` for identifier-like keys, `["a b"]` otherwise.
 *
 * @param key - The property name.
 * @returns The path segment.
 */
export function formatKey(key: string): string {
  return /^[A-Z_$][\w$]*$/i.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`;
}

/**
 * Reports whether a JSON value is an object (not an array or `null`).
 *
 * @param value - The value to inspect.
 * @returns `true` for JSON objects.
 */
function isObject(value: JsonValue | undefined): value is SchemaNode {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Compares two JSON values structurally; object key order is ignored.
 *
 * @param left - The first value.
 * @param right - The second value.
 * @returns `true` when the values are equal.
 */
export function deepEqual(left: JsonValue | undefined, right: JsonValue | undefined): boolean {
  if (left === right)
    return true;
  if (typeof left !== "object" || typeof right !== "object" || left === null || right === null)
    return false;
  if (Array.isArray(left) || Array.isArray(right))
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((entry, index) => deepEqual(entry, right[index]));
  const leftObject = left as SchemaNode;
  const rightObject = right as SchemaNode;
  const leftKeys = Object.keys(leftObject);
  return leftKeys.length === Object.keys(rightObject).length && leftKeys.every(key => key in rightObject && deepEqual(leftObject[key], rightObject[key]));
}