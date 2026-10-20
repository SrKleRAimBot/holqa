import type {
  EventAnalysis,
  EventGraphHandlerNode,
  PublicationEdge
} from "@holqa/compiler";
import type { DiagnosticLocation } from "@holqa/core";

import { describeCyclePath } from "@holqa/compiler";

/**
 * Renders an event analysis for a terminal: every handler with what
 * triggers it and what it publishes, the cycles (reported and allowed), and
 * the calls analysis could not resolve. Use `--json` for the full graph.
 *
 * @param application - The application's name.
 * @param events - The analysis.
 * @param where - Renders a root-relative location for the reader.
 * @returns The text, without a trailing newline.
 */
export function formatEventInspection(application: string, events: EventAnalysis, where: (location: DiagnosticLocation) => string): string {
  const { graph, cycles } = events;
  const handlers = graph.nodes.filter((node): node is EventGraphHandlerNode => node.type === "handler");
  const triggers = new Map<string, string>();
  const publications = new Map<string, PublicationEdge[]>();
  for (const edge of graph.edges) {
    if (edge.relation === "consumes")
      triggers.set(edge.to, `${edge.event} <- "${edge.from.slice("resource:".length)}"${edge.prefix === undefined ? "" : ` (prefix "${edge.prefix}")`}`);
    else
      publications.set(edge.from, [...publications.get(edge.from) ?? [], edge]);
  }
  const reported = cycles.filter(cycle => cycle.status === "reported");
  const lines = [`Event graph of "${application}"`, "", `Handlers (${handlers.length})`];
  if (handlers.length === 0)
    lines.push("  (none)");
  for (const handler of handlers) {
    const limits = [handler.maxDepth === undefined ? "" : `maxDepth ${handler.maxDepth}`, handler.maxPublications === undefined ? "" : `maxPublications ${handler.maxPublications}`].filter(Boolean).join(", ");
    lines.push(`  ${handler.id}  ${triggers.get(handler.key) ?? handler.trigger}  analysis ${handler.coverage}${limits === "" ? "" : `  ${limits}`}`);
    for (const edge of publications.get(handler.key) ?? [])
      lines.push(`    ${edge.operation} "${edge.to.slice("resource:".length)}"  ${edge.certainty}${edge.origin === "declared" ? " (declared)" : ""}${edge.call === undefined ? "" : `  ${edge.call}`}${edge.via === undefined ? "" : ` via ${edge.via.join(" → ")}`}${edge.location === undefined ? "" : `  ${where(edge.location)}`}`);
  }
  lines.push("", `Cycles (${reported.length} reported, ${cycles.length - reported.length} allowed)`);
  if (cycles.length === 0)
    lines.push("  (none)");
  for (const cycle of cycles) {
    const label = cycle.status === "allowed" ? "allowed" : cycle.certainty === "known" ? "warning" : "info   ";
    lines.push(`  ${label}  ${cycle.certainty.padEnd(9)}  ${describeCyclePath(cycle.path)}`);
    const first = cycle.path.find(step => step.location !== undefined)?.location;
    if (first !== undefined)
      lines.push(`             at ${where(first)}`);
    for (const allowance of cycle.allowedBy ?? [])
      lines.push(`             allowed by ${allowance.handler}: ${allowance.justification}`);
  }
  if (graph.unresolved.length > 0) {
    lines.push("", `Unresolved publications (${graph.unresolved.length})`);
    for (const publication of graph.unresolved)
      lines.push(`  ${publication.handler}  ${publication.call ?? publication.operation}${publication.location === undefined ? "" : `  ${where(publication.location)}`}`);
    lines.push("  Analysis cannot tell what these calls publish. Declare the targets with events: { publishes: [...] } on the handler if they matter.");
  }
  if (reported.length > 0)
    lines.push("", "Cycles may terminate; the compiler cannot prove it. Runtime limits (depth, publications, operation budgets) stop chains that do not.");
  return lines.join("\n");
}
