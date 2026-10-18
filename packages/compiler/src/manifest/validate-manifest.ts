import type {
  Diagnostic,
  Result
} from "@holqa/core";

import type { EntrypointMap } from "@/manifest/entrypoints";
import type {
  Manifest,
  ManifestSchemaReference
} from "@/manifest/manifest";

import {
  createDiagnostic,
  diagnosticCodes,
  err,
  isJsonValue,
  ok,
  resourceKindOfTrigger
} from "@holqa/core";

import { schemaRoleProblems } from "@/analysis/kinds";
import { compareCodeUnits } from "@/discovery/module-path";
import { manifestVersion } from "@/manifest/manifest";
import {
  entrypointsJsonSchema,
  manifestJsonSchema
} from "@/manifest/manifest-json-schema";
import { fingerprintManifest } from "@/manifest/serialize-manifest";
import { validateJsonSchema } from "@/validation/json-schema-validator";

/**
 * Reads an untrusted manifest document, such as a parsed `manifest.json` or
 * the output of an analysis process, and returns it typed only when it is a
 * valid version 1 manifest.
 *
 * Checks the manifest JSON Schema (`manifestJsonSchema`) and the
 * cross-references a schema cannot express: resources, handlers and
 * configuration entries sorted by unique identity, capabilities sorted, every
 * schema reference resolvable, every trigger targeting a declared resource of
 * the right kind, schema roles that fit each resource and trigger kind, a
 * queue message's `schemaVersion` equal to the queue's, and no default on a secret.
 *
 * @param value - The parsed JSON document.
 * @returns The manifest, or `HOLQA_MANIFEST_VERSION_UNSUPPORTED` for another
 * version, or `HOLQA_MANIFEST_INVALID` diagnostics (one per problem, with the JSON path in `details.path`).
 */
export function validateManifest(value: unknown): Result<Manifest, readonly Diagnostic[]> {
  // Kept as `unknown`: the JSON Schema and the checks below establish the `Manifest` shape, not `isJsonValue`.
  const document: unknown = value;
  if (typeof value === "object" && value !== null && "manifestVersion" in value && value.manifestVersion !== manifestVersion) {
    return err([createDiagnostic({
      code: diagnosticCodes.manifestVersionUnsupported,
      severity: "error",
      message: `The manifest has version ${JSON.stringify(value.manifestVersion)}, but this reader understands version ${manifestVersion} only.`,
      hint: "Use a Holqa version that matches the compiler that produced the manifest, or rebuild the manifest.",
      details: { found: typeof value.manifestVersion === "number" ? value.manifestVersion : null, supported: [manifestVersion] }
    })]);
  }
  if (!isJsonValue(value))
    return err([invalid("manifest", "$", "must be plain JSON data")]);
  const problems = validateJsonSchema(manifestJsonSchema, value);
  if (problems.length > 0)
    return err(problems.map(problem => invalid("manifest", problem.path, problem.message)));

  const manifest = document as Manifest;
  const references: Array<readonly [string, ManifestSchemaReference]> = [];
  const violations: Array<readonly [string, string]> = [];
  sortedUnique(manifest.resources.map(resource => resource.id), "$.resources", "id", violations);
  sortedUnique(manifest.handlers.map(handler => handler.id), "$.handlers", "id", violations);
  sortedUnique(manifest.config.map(entry => entry.name), "$.config", "name", violations);
  sortedUnique(manifest.requiredCapabilities, "$.requiredCapabilities", "value", violations);

  const kinds = new Map(manifest.resources.map(resource => [resource.id as string, resource.kind as string]));
  manifest.resources.forEach((resource, index) => {
    for (const problem of schemaRoleProblems("resource", resource.kind, Object.keys(resource.schemas)))
      violations.push([`$.resources[${index}].schemas`, problem]);
    for (const [role, reference] of Object.entries(resource.schemas))
      references.push([`$.resources[${index}].schemas.${role}`, reference]);
    const { message } = resource.schemas;
    if (resource.kind === "queue" && message !== undefined && message.schemaVersion !== resource.config.schemaVersion)
      violations.push([`$.resources[${index}].schemas.message.schemaVersion`, "must equal the queue's config.schemaVersion"]);
  });
  manifest.handlers.forEach((handler, index) => {
    const { resource } = handler.trigger;
    if (kinds.get(resource.id) !== resource.kind || resourceKindOfTrigger(handler.trigger.kind) !== resource.kind)
      violations.push([`$.handlers[${index}].trigger.resource`, `must reference a declared ${resourceKindOfTrigger(handler.trigger.kind)}`]);
    for (const problem of schemaRoleProblems("trigger", handler.trigger.kind, Object.keys(handler.schemas)))
      violations.push([`$.handlers[${index}].schemas`, problem]);
    for (const [role, reference] of Object.entries(handler.schemas))
      references.push([`$.handlers[${index}].schemas.${role}`, reference]);
  });
  manifest.config.forEach((entry, index) => {
    if (entry.kind === "secret" && entry.default !== undefined)
      violations.push([`$.config[${index}].default`, "must not be present on a secret"]);
    references.push([`$.config[${index}].schema`, entry.schema]);
  });
  for (const [path, reference] of references) {
    if (!Object.hasOwn(manifest.schemas, reference.fingerprint))
      violations.push([`${path}.fingerprint`, "must name an entry of $.schemas"]);
  }
  return violations.length === 0 ? ok(manifest) : err(violations.map(([path, message]) => invalid("manifest", path, message)));
}

/**
 * Reads an untrusted entry point map and checks that it belongs to the given
 * manifest: its `manifest` fingerprint matches, and it locates exactly the
 * manifest's handlers.
 *
 * @param value - The parsed JSON document.
 * @param manifest - The validated manifest the map must belong to.
 * @returns The entry point map, or `HOLQA_MANIFEST_INVALID` diagnostics.
 */
export async function validateEntrypoints(value: unknown, manifest: Manifest): Promise<Result<EntrypointMap, readonly Diagnostic[]>> {
  // Kept as `unknown`: the JSON Schema and the checks below establish the `EntrypointMap` shape.
  const document: unknown = value;
  if (!isJsonValue(value))
    return err([invalid("entry point map", "$", "must be plain JSON data")]);
  const problems = validateJsonSchema(entrypointsJsonSchema, value);
  if (problems.length > 0)
    return err(problems.map(problem => invalid("entry point map", problem.path, problem.message)));
  const entrypoints = document as EntrypointMap;
  const violations: Array<readonly [string, string]> = [];
  if (entrypoints.manifest !== await fingerprintManifest(manifest))
    violations.push(["$.manifest", "must be the fingerprint of the manifest it belongs to"]);
  sortedUnique(entrypoints.handlers.map(handler => handler.id), "$.handlers", "id", violations);
  const expected = manifest.handlers.map(handler => handler.id as string);
  const actual = entrypoints.handlers.map(handler => handler.id as string);
  if (expected.length !== actual.length || expected.some((id, index) => id !== actual[index]))
    violations.push(["$.handlers", "must list exactly the manifest's handlers"]);
  entrypoints.handlers.forEach((handler, index) => {
    if (!handler.exports.includes(handler.export))
      violations.push([`$.handlers[${index}].export`, "must be one of the handler's exports"]);
  });
  return violations.length === 0 ? ok(entrypoints) : err(violations.map(([path, message]) => invalid("entry point map", path, message)));
}

/**
 * Records a violation when a list is not strictly ascending.
 *
 * @param values - The identities, in document order.
 * @param path - The JSON path of the list.
 * @param field - The identity field, for messages.
 * @param violations - Receives `[path, message]` pairs.
 */
function sortedUnique(values: readonly string[], path: string, field: string, violations: Array<readonly [string, string]>): void {
  values.forEach((value, index) => {
    if (index > 0 && compareCodeUnits(values[index - 1]!, value) >= 0)
      violations.push([`${path}[${index}]`, `must be sorted by ${field} with no duplicates`]);
  });
}

/**
 * Builds a `HOLQA_MANIFEST_INVALID` diagnostic.
 *
 * @param document - What was validated, for the message.
 * @param path - The JSON path of the problem.
 * @param message - What is wrong at that path.
 * @returns The diagnostic.
 */
function invalid(document: string, path: string, message: string): Diagnostic {
  return createDiagnostic({
    code: diagnosticCodes.manifestInvalid,
    severity: "error",
    message: `The ${document} is invalid: ${path} ${message}.`,
    details: { path }
  });
}