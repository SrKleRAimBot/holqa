import type {
  JsonObject,
  ResourceKind,
  RuntimeOnlyKind,
  TriggerKind
} from "@holqa/core";

import { resourceKindOfTrigger } from "@holqa/core";

import { entrypointsFormat } from "@/manifest/entrypoints";
import {
  manifestRuntimes,
  manifestVersion
} from "@/manifest/manifest";
import {
  jsonSchemaDialect,
  schemaContractFormat
} from "@/schema/schema-contract";

/** Every runtime-only constraint kind. Typing it as a full record makes a new `RuntimeOnlyKind` a compile error until it is listed. */
const runtimeOnlyKindSet: Readonly<Record<RuntimeOnlyKind, true>> = { check: true, coercion: true, fallback: true, pipe: true, preprocess: true, refinement: true, rewrite: true };

/** The runtime-only constraint kinds, sorted. */
const runtimeOnlyKinds = Object.keys(runtimeOnlyKindSet).sort();

/**
 * Builds a closed object schema: every listed property is allowed, the
 * `required` ones must be present, and nothing else may appear.
 *
 * @param properties - Property schemas by name.
 * @param required - The required property names.
 * @returns The object schema.
 */
function closedObject(properties: JsonObject, required: readonly string[] = Object.keys(properties)): JsonObject {
  return { type: "object", additionalProperties: false, required: [...required], properties };
}

/**
 * Builds a reference to an entry of `$defs`.
 *
 * @param name - The definition's name, for example `identifier`.
 * @returns A `$ref` schema.
 */
const ref = (name: string): JsonObject => ({ $ref: `#/$defs/${name}` });

/**
 * Builds the schema of a trigger's resource reference.
 *
 * @param kind - The resource kind the trigger requires, for example `queue`.
 * @returns A closed object schema with a constant `kind` and an identifier.
 */
const resourceReference = (kind: string): JsonObject => closedObject({ kind: { const: kind }, id: ref("identifier") });

/**
 * Builds the schema of one resource kind's manifest entry.
 *
 * @param kind - The resource kind, the entry's constant `kind`.
 * @param config - The schema of the kind's normalized `config`.
 * @param requirements - The schema of the kind's `requirements`.
 * @returns A closed object schema.
 */
function resourceDefinition(kind: ResourceKind, config: JsonObject, requirements: JsonObject): JsonObject {
  return closedObject({ id: ref("identifier"), kind: { const: kind }, config, requirements, schemas: ref("schemaReferences") });
}

/**
 * One definition per resource kind, named `resource-<kind>` in `$defs` (dots become dashes). The mapped type
 * makes a kind added to the core registry a compile error until it has one.
 */
const resourceDefinitionsByKind: { readonly [Kind in ResourceKind]: JsonObject } = {
  "queue": resourceDefinition("queue", closedObject({ schemaVersion: ref("positiveInteger") }), closedObject({ delivery: { enum: ["at-least-once"] }, deadLetter: { type: "boolean" }, maxAttempts: ref("positiveInteger") }, ["delivery", "deadLetter"])),
  "bucket": resourceDefinition("bucket", closedObject({}), closedObject({ access: { enum: ["private", "public-read"] } })),
  "schedule": resourceDefinition("schedule", closedObject({ cron: { type: "string", pattern: "^[\\w*?,/-]+(?: [\\w*?,/-]+){4}$" }, timezone: { type: "string", minLength: 1 } }), closedObject({ overlap: { enum: ["skip", "allow"] } })),
  "http.api": resourceDefinition("http.api", closedObject({
    basePath: { type: "string", pattern: "^/$|^(?:/[\\w.~-]+)+$" },
    docs: closedObject({ title: { type: "string", minLength: 1 }, version: { type: "string", minLength: 1 } })
  }, ["basePath"]), closedObject({}))
};

/**
 * Builds the schema of one trigger kind.
 *
 * @param kind - The trigger kind, the trigger's constant `kind`.
 * @param options - The schema of the trigger's normalized `options`.
 * @returns A closed object schema whose resource reference has the trigger's resource kind.
 */
function triggerDefinition(kind: TriggerKind, options: JsonObject): JsonObject {
  return closedObject({ kind: { const: kind }, resource: resourceReference(resourceKindOfTrigger(kind)), options });
}

/** One definition per trigger kind; adding a trigger kind without one is a compile error. */
const triggerDefinitionsByKind: { readonly [Trigger in TriggerKind]: JsonObject } = {
  "queue.message": triggerDefinition("queue.message", closedObject({ concurrency: ref("positiveInteger") }, [])),
  "bucket.object-created": triggerDefinition("bucket.object-created", closedObject({ prefix: { type: "string" } }, [])),
  "schedule.tick": triggerDefinition("schedule.tick", closedObject({})),
  "http.route": triggerDefinition("http.route", closedObject({
    method: { enum: ["GET", "POST", "PUT", "PATCH", "DELETE"] },
    path: { type: "string", pattern: "^/$|^(?:/(?:[\\w.~-]+|:[A-Za-z_]\\w*))+$" }
  }))
};

/** Resource definitions keyed by their `$defs` name. */
const resourceDefinitions: JsonObject = Object.fromEntries(Object.entries(resourceDefinitionsByKind).map(([kind, definition]) => [`resource-${kind.replaceAll(".", "-")}`, definition]));

/** Trigger definitions keyed by their `$defs` name. */
const triggerDefinitions: JsonObject = Object.fromEntries(Object.entries(triggerDefinitionsByKind).map(([kind, definition]) => [`trigger-${kind.replaceAll(".", "-")}`, definition]));

/**
 * Freezes a JSON value and everything inside it, so that no consumer can
 * change what the exported schemas validate.
 *
 * @param value - A JSON value built in this module.
 * @returns The same value, frozen at every depth.
 */
function deepFreeze<Value extends JsonObject>(value: Value): Value {
  for (const entry of Object.values(value)) {
    if (typeof entry === "object" && entry !== null)
      deepFreeze(entry as JsonObject);
  }
  return Object.freeze(value);
}

/** Definitions shared by the manifest and entry point schemas. */
const commonDefinitions: JsonObject = {
  identifier: { type: "string", pattern: "^[a-z][a-z0-9]*(?:[-.][a-z0-9]+)*$", maxLength: 63 },
  fingerprint: { type: "string", pattern: "^sha256:[0-9a-f]{64}$" },
  positiveInteger: { type: "integer", minimum: 1 }
};

/**
 * The JSON Schema (draft 2020-12) of version 1 of the Holqa application
 * manifest. `validateManifest` checks documents against it, plus the
 * cross-references a JSON Schema cannot express (sorted unique identities,
 * resolvable schema references and trigger targets, no secret defaults).
 */
export const manifestJsonSchema: JsonObject = deepFreeze({
  $schema: jsonSchemaDialect,
  $id: `urn:holqa:schema:manifest:${manifestVersion}`,
  title: "Holqa application manifest, version 1",
  ...closedObject({
    manifestVersion: { const: manifestVersion },
    application: closedObject({ name: ref("identifier"), description: { type: "string" } }, ["name"]),
    runtime: { enum: [...manifestRuntimes] },
    resources: { type: "array", items: ref("resource") },
    handlers: { type: "array", items: ref("handler") },
    config: { type: "array", items: ref("configEntry") },
    requiredCapabilities: { type: "array", uniqueItems: true, items: { type: "string", pattern: "^[a-z][a-z0-9]*(?:[-.][a-z0-9]+)*$" } },
    schemas: { type: "object", propertyNames: ref("fingerprint"), additionalProperties: ref("schemaContract") }
  }),
  $defs: {
    ...commonDefinitions,
    schemaSource: closedObject({ vendor: { type: "string" }, library: { type: "string" }, fidelity: { enum: ["verified", "unverified"] } }),
    schemaReference: closedObject({ fingerprint: ref("fingerprint"), source: ref("schemaSource"), schemaVersion: ref("positiveInteger") }, ["fingerprint", "source"]),
    schemaReferences: {
      type: "object",
      propertyNames: { type: "string", pattern: "^(?:message|object|params|query|body|value|response\\.[1-5][0-9]{2})$" },
      additionalProperties: ref("schemaReference")
    },
    resource: { oneOf: Object.keys(resourceDefinitions).map(name => ref(name)) },
    ...resourceDefinitions,
    trigger: { oneOf: Object.keys(triggerDefinitions).map(name => ref(name)) },
    ...triggerDefinitions,
    handler: closedObject({ id: ref("identifier"), trigger: ref("trigger"), schemas: ref("schemaReferences") }),
    configEntry: closedObject({
      name: { type: "string", pattern: "^[A-Za-z_]\\w*$" },
      kind: { enum: ["secret", "variable"] },
      schema: ref("schemaReference"),
      default: true
    }, ["name", "kind", "schema"]),
    runtimeOnlyConstraint: closedObject({ path: { type: "string" }, kind: { enum: [...runtimeOnlyKinds] }, detail: { type: "string" } }),
    schemaSide: closedObject({ jsonSchema: { type: "object" }, runtimeOnly: { type: "array", items: ref("runtimeOnlyConstraint") } }),
    schemaContract: closedObject({
      format: { const: schemaContractFormat },
      dialect: { const: jsonSchemaDialect },
      encoding: { const: "json" },
      input: ref("schemaSide"),
      output: {
        oneOf: [
          closedObject({ representable: { const: true }, jsonSchema: { type: "object" }, runtimeOnly: { type: "array", items: ref("runtimeOnlyConstraint") } }),
          closedObject({ representable: { const: false }, problem: closedObject({ path: { type: "string" }, reason: { type: "string" }, hint: { type: "string" } }, ["path", "reason"]) })
        ]
      }
    })
  }
});

/**
 * The JSON Schema (draft 2020-12) of version 1 of the entry point map.
 * `validateEntrypoints` checks documents against it and against the manifest
 * they claim to belong to.
 */
export const entrypointsJsonSchema: JsonObject = deepFreeze({
  $schema: jsonSchemaDialect,
  $id: `urn:holqa:schema:entrypoints:1`,
  title: "Holqa entry point map, version 1",
  ...closedObject({
    format: { const: entrypointsFormat },
    manifest: ref("fingerprint"),
    application: closedObject({
      module: ref("modulePath"),
      handlers: closedObject({ include: { type: "array", items: { type: "string", minLength: 1 } }, exclude: { type: "array", items: { type: "string", minLength: 1 } } })
    }),
    handlers: {
      type: "array",
      items: closedObject({ id: ref("identifier"), module: ref("modulePath"), export: { type: "string", minLength: 1 }, exports: { type: "array", minItems: 1, uniqueItems: true, items: { type: "string", minLength: 1 } } })
    }
  }),
  $defs: {
    ...commonDefinitions,
    modulePath: { type: "string", pattern: "^(?![a-zA-Z]:)(?!/)(?!.*(?:^|/)\\.{1,2}(?:/|$))(?!.*//)[^\\\\]+$" }
  }
});