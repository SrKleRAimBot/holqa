import type {
  JsonObject,
  SchemaAdapter
} from "@holqa/core";

import {
  err,
  hasStandardJsonSchema,
  isJsonValue,
  ok
} from "@holqa/core";

/**
 * Describes schemas that Holqa itself defines (Standard Schema vendor
 * `holqa`), such as the SDK's portable object-created event. Those schemas
 * are written by hand together with their JSON Schema, which they expose
 * through Standard JSON Schema, so their descriptions are complete and are
 * recorded as verified. The compiler always uses this adapter after any
 * adapters a host supplies.
 */
export const holqaSchemaAdapter: SchemaAdapter = {
  vendor: "holqa",
  library: "holqa",
  describe: (schema, side) => {
    if (!hasStandardJsonSchema(schema))
      return err({ path: "$", reason: "the Holqa schema does not describe itself with Standard JSON Schema." });
    const raw: unknown = schema["~standard"].jsonSchema[side]({ target: "draft-2020-12" });
    if (typeof raw !== "object" || raw === null || Array.isArray(raw) || !isJsonValue(raw))
      return err({ path: "$", reason: "the Holqa schema produced a JSON Schema that is not a plain object." });
    return ok({ jsonSchema: raw as JsonObject, runtimeOnly: [] });
  }
};