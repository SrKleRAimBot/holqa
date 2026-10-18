import type {
  EntrypointMap,
  Manifest,
  ManifestResource,
  ManifestSchemaReferences,
  ManifestTrigger
} from "@holqa/compiler";

/**
 * Renders a manifest and its entry points as a human-readable summary:
 * resources with their requirements and contracts, handlers with their
 * triggers and modules, configuration entries, and required capabilities.
 * Fingerprints are shortened to 12 hex digits; use `--json` for the full data.
 *
 * @param manifest - A validated manifest.
 * @param entrypoints - The entry point map that belongs to it.
 * @returns The text, without a trailing newline.
 */
export function formatInspection(manifest: Manifest, entrypoints: EntrypointMap): string {
  const modules = new Map(entrypoints.handlers.map(handler => [handler.id as string, `${handler.module}#${handler.export}`]));
  const lines = [
    `Application "${manifest.application.name}"${manifest.application.description === undefined ? "" : ` - ${manifest.application.description}`}`,
    `  manifest version ${manifest.manifestVersion}, runtime ${manifest.runtime}`,
    "",
    `Resources (${manifest.resources.length})`,
    ...table(manifest.resources.map(resource => [resource.kind, resource.id, describeResource(resource)])),
    "",
    `Handlers (${manifest.handlers.length})`,
    ...table(manifest.handlers.map(handler => [handler.id, describeTrigger(handler.trigger), [contracts(handler.schemas), modules.get(handler.id) ?? ""].filter(Boolean).join("  ")])),
    "",
    `Configuration (${manifest.config.length})`,
    ...table(manifest.config.map(entry => [entry.kind, entry.name, entry.default === undefined ? "" : `default ${JSON.stringify(entry.default)}`])),
    "",
    `Required capabilities (${manifest.requiredCapabilities.length})`,
    ...manifest.requiredCapabilities.map(capability => `  ${capability}`)
  ];
  return lines.join("\n");
}

/**
 * Describes a resource's configuration, requirements and contracts in one line.
 *
 * @param resource - A manifest resource.
 * @returns The description.
 */
function describeResource(resource: ManifestResource): string {
  switch (resource.kind) {
    case "queue": {
      const { requirements } = resource;
      const delivery = [requirements.delivery, ...requirements.maxAttempts === undefined ? [] : [`max ${requirements.maxAttempts} attempts`], ...requirements.deadLetter ? ["dead-letter"] : []].join(", ");
      return `${delivery}  ${contracts(resource.schemas)}`;
    }
    case "bucket":
      return `access ${resource.requirements.access}`;
    case "schedule":
      return `"${resource.config.cron}" ${resource.config.timezone}, overlap ${resource.requirements.overlap}`;
    case "http.api":
      return `base path ${resource.config.basePath}`;
  }
}

/**
 * Describes a trigger as `kind <- resource-kind "id"` with its options.
 *
 * @param trigger - A manifest trigger.
 * @returns The description.
 */
function describeTrigger(trigger: ManifestTrigger): string {
  const options = Object.entries(trigger.options).map(([name, value]) => `${name} ${String(value)}`).join(", ");
  return `${trigger.kind} <- ${trigger.resource.kind} "${trigger.resource.id}"${options === "" ? "" : ` (${options})`}`;
}

/**
 * Lists schema references as `role vN sha256:abcdef012345`.
 *
 * @param schemas - Schema references by role.
 * @returns The list, or an empty string when there are none.
 */
function contracts(schemas: ManifestSchemaReferences): string {
  return Object.entries(schemas)
    .map(([role, reference]) => `${role}${reference.schemaVersion === undefined ? "" : ` v${reference.schemaVersion}`} ${reference.fingerprint.slice(0, "sha256:".length + 12)}`)
    .join(", ");
}

/**
 * Aligns rows into indented columns.
 *
 * @param rows - Cells by row; the last column is not padded.
 * @returns One line per row, or `  (none)` when there are no rows.
 */
function table(rows: ReadonlyArray<readonly string[]>): string[] {
  if (rows.length === 0)
    return ["  (none)"];
  const widths = rows[0]!.map((_, column) => Math.max(...rows.map(row => row[column]!.length)));
  return rows.map(row => `  ${row.map((cell, column) => column === row.length - 1 ? cell : cell.padEnd(widths[column]!)).join("  ")}`.trimEnd());
}
