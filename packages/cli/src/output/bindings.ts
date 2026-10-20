import type {
  BindingReport,
  CapabilitySupport
} from "@holqa/bindings";
import type { Manifest } from "@holqa/compiler";

import {
  formatDiagnostic,
  requiredCapabilities
} from "@holqa/core";

/** How each kind of support is marked in text output. */
const marks: Readonly<Record<CapabilitySupport, string>> = { native: "ok", emulated: "emulated", unsupported: "MISSING" };

/** How each selection source is described. */
const selections = { resource: "resource override", kind: "kind default", default: "platform default", service: "service override", builtin: "built-in" } as const;

/**
 * Pads the cells of rows into aligned columns.
 *
 * @param rows - Rows of cells.
 * @returns One line per row, indented by two spaces.
 */
function columns(rows: readonly (readonly string[])[]): string[] {
  const widths = rows.reduce<number[]>((current, row) => row.map((cell, index) => Math.max(current[index] ?? 0, cell.length)), []);
  return rows.map(row => `  ${row.map((cell, index) => index === row.length - 1 ? cell : cell.padEnd(widths[index]!)).join("  ")}`.trimEnd());
}

/**
 * Renders a binding report for people: which provider binds each resource and
 * why, how each requirement is met, the services and every provider, then the
 * problems found.
 *
 * @param report - The report from the analysis.
 * @returns The text, without a trailing newline.
 */
export function formatBindingReport(report: BindingReport): string {
  const lines = [`Bindings "${report.name}" for application "${report.application}"`, "", "Resources:"];
  lines.push(...columns(report.resources.map(resource => [
    resource.id,
    resource.kind,
    resource.provider,
    selections[resource.selection],
    resource.requirements.map(requirement => `${requirement.capability} ${marks[requirement.support]}`).join(", ")
  ])));
  lines.push("", "Services:");
  lines.push(...report.services.length === 0 ? ["  none"] : columns(report.services.map(service => [service.service, service.providers.join(", "), selections[service.selection]])));
  lines.push("", "Providers:");
  lines.push(...columns(report.providers.map(provider => [
    provider.name,
    provider.provider,
    provider.role,
    Object.entries(provider.contracts).map(([contract, version]) => `${contract}@${version}`).join(" "),
    provider.credentials.length === 0 ? "" : `credentials: ${provider.credentials.join(", ")}`
  ])));
  for (const provider of report.providers) {
    for (const emulation of provider.emulations)
      lines.push(`  ${provider.name} emulates ${emulation.capability}: ${emulation.mechanism}${emulation.requires === undefined ? "" : ` (needs ${emulation.requires.join(", ")})`}`);
    if (provider.topology.connectors !== undefined && provider.topology.connectors.length > 0)
      lines.push(`  ${provider.name} needs: ${provider.topology.connectors.join(", ")}`);
  }
  if (report.diagnostics.length > 0)
    lines.push("", "Problems:", ...report.diagnostics.map(diagnostic => `  ${formatDiagnostic(diagnostic).replaceAll("\n", "\n  ")}`));
  return lines.join("\n");
}

/** One resource's capabilities: what it requires and, with a binding configuration, how its provider meets each. */
export interface CapabilityEntry {
  readonly resource: string;
  readonly kind: string;
  readonly provider?: string;
  readonly requirements: ReadonlyArray<{ readonly capability: string; readonly support?: CapabilitySupport }>;
}

/**
 * Lists every resource's required capabilities from a manifest, with the
 * provider's support when a binding report is given.
 *
 * @param manifest - The application's manifest.
 * @param report - The binding report, if a binding configuration was resolved.
 * @returns One entry per resource, sorted by identifier.
 */
export function capabilityEntries(manifest: Manifest, report?: BindingReport): CapabilityEntry[] {
  return manifest.resources.map((resource) => {
    const bound = report?.resources.find(candidate => candidate.id === resource.id);
    const triggers = [...new Set(manifest.handlers.filter(handler => handler.trigger.resource.id === resource.id).map(handler => `trigger.${handler.trigger.kind}`))].sort();
    const required = bound === undefined ? [...requiredCapabilities(resource), ...triggers].map(capability => ({ capability })) : bound.requirements;
    return { resource: resource.id, kind: resource.kind, ...bound === undefined ? {} : { provider: bound.provider }, requirements: required };
  });
}

/**
 * Renders capability entries for people.
 *
 * @param entries - The entries.
 * @param bindings - The binding configuration's name, when one was resolved.
 * @returns The text, without a trailing newline.
 */
export function formatCapabilities(entries: readonly CapabilityEntry[], bindings?: string): string {
  const header = bindings === undefined ? "Required capabilities (pass --bindings to compare with providers):" : `Capabilities required and provided by the binding configuration "${bindings}":`;
  return [header, ...columns(entries.map(entry => [
    entry.resource,
    entry.kind,
    ...entry.provider === undefined ? [] : [entry.provider],
    entry.requirements.map(requirement => requirement.support === undefined ? requirement.capability : `${requirement.capability} ${marks[requirement.support]}`).join(", ")
  ]))].join("\n");
}