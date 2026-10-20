import type {
  Diagnostic,
  DiagnosticLocation,
  HandlerDescriptor,
  ResourceKind
} from "@holqa/core";

import type { EventCycle } from "@/events/cycles";
import type {
  EventGraph,
  EventPublication,
  HandlerEventFacts
} from "@/events/event-graph";
import type { ModuleResolver } from "@/events/publications";
import type { Manifest } from "@/manifest/manifest";

import {
  createDiagnostic,
  diagnosticCodes,
  eventPolicyProblems,
  idempotencyPolicyProblems
} from "@holqa/core";

import {
  analyzeEventCycles,
  eventCycleDiagnostics
} from "@/events/cycles";
import { buildEventGraph } from "@/events/event-graph";
import { analyzePublications } from "@/events/publications";

/**
 * The event safety analysis of an application: its event dependency graph
 * and the cycles in it. Produced alongside the manifest but not part of it:
 * publications come from handler code, which changes without changing the
 * application's declared infrastructure.
 */
export interface EventAnalysis {
  readonly graph: EventGraph;
  /** Reported cycles first, then allowed ones. */
  readonly cycles: readonly EventCycle[];
}

/** A handler with its descriptor, module and registration location. */
export interface AnalyzedHandler {
  readonly descriptor: HandlerDescriptor;
  readonly module: string;
  readonly location: DiagnosticLocation;
}

/** What {@link analyzeEvents} reads. */
export interface AnalyzeEventsInput {
  readonly manifest: Manifest;
  /** One entry per handler identifier. */
  readonly handlers: readonly AnalyzedHandler[];
  /** Source texts by root-relative path. Without them, only declared publications are known. */
  readonly sources: Readonly<Record<string, string>>;
  /** Evaluated module namespaces by root-relative path. */
  readonly namespaces: ReadonlyMap<string, Readonly<Record<string, unknown>>>;
  readonly resolve?: ModuleResolver;
}

/** Trigger kinds whose handlers may declare an idempotency policy. */
const idempotentTriggers: ReadonlySet<string> = new Set(["queue.message", "bucket.object-created", "bucket.object-deleted"]);

/** Resource kinds that deliver events handlers publish. */
const publishable: ReadonlySet<ResourceKind> = new Set(["queue", "bucket"]);

/**
 * Checks the event and idempotency policies handlers declare: their shape,
 * that declared publication targets are declared queues or buckets, and that
 * only queue consumers and object event handlers declare idempotency.
 *
 * @param handlers - The handlers, one per identifier.
 * @param resources - The declared resources' kinds by identifier.
 * @returns One error per problem.
 */
export function checkEventPolicies(handlers: readonly AnalyzedHandler[], resources: ReadonlyMap<string, ResourceKind>): Diagnostic[] {
  const problems: Diagnostic[] = [];
  for (const { descriptor, location } of handlers) {
    const { definition } = descriptor;
    const label = `The handler "${definition.id}"`;
    /**
     * Records one invalid declaration of this handler.
     *
     * @param message - What is wrong.
     */
    const invalid = (message: string): void => {
      problems.push(createDiagnostic({ code: diagnosticCodes.declarationInvalid, severity: "error", message: `${label}: ${message}`, location, details: { handler: definition.id } }));
    };
    const eventProblems = eventPolicyProblems(definition.events);
    const idempotencyProblems = idempotencyPolicyProblems(definition.idempotency);
    for (const problem of [...eventProblems, ...idempotencyProblems])
      invalid(problem);
    if (definition.idempotency !== undefined && !idempotentTriggers.has(definition.trigger.kind))
      invalid(`${definition.trigger.kind} handlers cannot declare "idempotency"; only queue consumers and object event handlers can.`);
    if (eventProblems.length > 0)
      continue;
    for (const target of definition.events?.publishes ?? []) {
      const kind = resources.get(target.id);
      if (kind === undefined)
        problems.push(createDiagnostic({ code: diagnosticCodes.resourceNotFound, severity: "error", message: `${label} declares that it publishes to ${target.kind} "${target.id}", which the application does not declare.`, location, details: { handler: definition.id, resource: target.id } }));
      else if (kind !== target.kind || !publishable.has(kind))
        invalid(`"events.publishes" lists ${kind} "${target.id}"; only queues and buckets receive events that handlers publish.`);
    }
  }
  return problems;
}

/**
 * Builds the event dependency graph of a compiled application and finds its
 * cycles: analyzes every handler's code for publications, adds declared
 * publications, and reports cycles that no handler allows as
 * `HOLQA_EVENT_CYCLE` warnings (known) or information (potential). Never
 * fails: code analysis cannot read is reported as unknown or unavailable.
 *
 * Run {@link checkEventPolicies} first; malformed policies are ignored here.
 *
 * @param input - The manifest, handlers, sources, namespaces and resolver.
 * @returns The analysis and its diagnostics.
 */
export async function analyzeEvents(input: AnalyzeEventsInput): Promise<{ readonly analysis: EventAnalysis; readonly diagnostics: readonly Diagnostic[] }> {
  const analyzed = await analyzePublications({
    handlers: input.handlers.map(handler => ({ id: handler.descriptor.definition.id, module: handler.module, location: handler.location })),
    sources: input.sources,
    namespaces: input.namespaces,
    ...input.resolve === undefined ? {} : { resolve: input.resolve }
  });
  const coverage = new Map(analyzed.map(entry => [entry.handler, entry.coverage]));
  const publications: EventPublication[] = analyzed.flatMap(entry => entry.publications);
  const facts = new Map<string, HandlerEventFacts>();
  for (const { descriptor, location } of input.handlers) {
    const { id, events } = descriptor.definition;
    const valid = eventPolicyProblems(events).length === 0 ? events : undefined;
    for (const target of valid?.publishes ?? []) {
      if (target.kind !== "queue" && target.kind !== "bucket")
        continue;
      for (const operation of target.kind === "queue" ? ["send" as const] : ["put" as const, "delete" as const])
        publications.push({ handler: id, operation, target: { kind: target.kind, id: target.id }, certainty: "known", origin: "declared" });
    }
    facts.set(id, {
      coverage: coverage.get(id) ?? "unavailable",
      location,
      ...valid?.cycle === undefined ? {} : { cycle: { justification: valid.cycle.justification } },
      ...valid?.maxDepth === undefined ? {} : { maxDepth: valid.maxDepth },
      ...valid?.maxPublications === undefined ? {} : { maxPublications: valid.maxPublications }
    });
  }
  const graph = buildEventGraph(input.manifest, publications, facts);
  const cycles = analyzeEventCycles(graph);
  return { analysis: { graph, cycles }, diagnostics: eventCycleDiagnostics(cycles, graph) };
}