import type {
  HandlerDescriptor,
  JsonObject,
  ResourceDescriptor,
  StandardSchemaV1,
  TriggerDescriptor
} from "@holqa/experiment-model";

import {
  descriptorProtocol,
  experimentCodes,
  fail,
  isStandardSchema
} from "@holqa/experiment-model";

/**
 * Checks that every schema a declaration supplies implements Standard Schema.
 * This is the one check `defineApp`-time code performs eagerly, because a
 * non-schema value would make every later stage fail in confusing ways.
 *
 * @param owner - What declared the schemas, for the error message.
 * @param schemas - The supplied schemas by role.
 * @returns The same schemas, frozen.
 * @throws {HolqaError} `HOLQA_DECLARATION_INVALID` when a value is not a Standard Schema.
 */
export function checkSchemas(owner: string, schemas: Readonly<Record<string, unknown>>): Readonly<Record<string, StandardSchemaV1>> {
  const checked: Record<string, StandardSchemaV1> = {};
  for (const [role, schema] of Object.entries(schemas)) {
    if (schema === undefined)
      continue;
    if (!isStandardSchema(schema))
      fail(experimentCodes.declarationInvalid, `${owner}: "${role}" is not a Standard Schema.`, "Use a schema library that implements Standard Schema v1, such as Zod 4 or Valibot 1.");
    checked[role] = schema;
  }
  return Object.freeze(checked);
}

/**
 * Builds a frozen resource descriptor.
 *
 * @param kind - The resource kind, for example `queue`.
 * @param id - The declared identifier (validated later by the compiler and runtime).
 * @param config - JSON-serializable options.
 * @param schemas - Schemas by role.
 * @returns A frozen resource descriptor with checked schemas.
 */
export function resourceDescriptor(kind: string, id: string, config: JsonObject, schemas: Readonly<Record<string, unknown>>): ResourceDescriptor {
  return Object.freeze({
    protocol: descriptorProtocol,
    type: "resource",
    kind,
    id,
    config: Object.freeze(config),
    schemas: checkSchemas(`${kind} "${id}"`, schemas)
  });
}

/**
 * Builds a frozen handler descriptor.
 *
 * @param id - The handler identifier.
 * @param trigger - What invokes the handler.
 * @param config - JSON-serializable handler options.
 * @param schemas - Schemas by role.
 * @param invoke - Validates input and runs the user handler.
 * @returns A frozen handler descriptor with checked schemas.
 */
export function handlerDescriptor(id: string, trigger: TriggerDescriptor, config: JsonObject, schemas: Readonly<Record<string, unknown>>, invoke: HandlerDescriptor["invoke"]): HandlerDescriptor {
  return Object.freeze({
    protocol: descriptorProtocol,
    type: "handler",
    id,
    trigger: Object.freeze(trigger),
    config: Object.freeze(config),
    schemas: checkSchemas(`handler "${id}"`, schemas),
    invoke
  });
}

/**
 * Copies only the defined entries of an options object, so that optional
 * settings never appear as `undefined` in descriptors (which would not be
 * canonical-JSON serializable).
 *
 * @param entries - Candidate entries.
 * @returns A JSON object without `undefined` values.
 */
export function definedEntries(entries: Readonly<Record<string, JsonObject[string] | undefined>>): JsonObject {
  const result: Record<string, JsonObject[string]> = {};
  for (const [key, value] of Object.entries(entries)) {
    if (value !== undefined)
      result[key] = value;
  }
  return result;
}