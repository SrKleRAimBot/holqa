import type {
  DiagnosticLocation,
  HandlerCycleAllowance,
  ResourceKind,
  TriggerKind
} from "@holqa/core";

import type { Manifest } from "@/manifest/manifest";

import { compareCodeUnits } from "@/discovery/module-path";

/** What a handler does to a resource that may trigger other handlers. */
export type PublicationOperation = "send" | "put" | "delete";

/**
 * How sure the analysis is about a publication:
 *
 * - `known`: a call on a resolved resource handle in the handler's own code, or a declared `events.publishes` target;
 * - `potential`: a resolved resource reached through a helper function, a handle passed to another function, or an object key whose prefix analysis cannot compare with a handler's;
 * - `unknown`: a call that looks like a publication on something analysis cannot resolve (a parameter, a computed value, code outside the application).
 */
export type PublicationCertainty = "known" | "potential" | "unknown";

/** Where a publication was found. */
export type PublicationOrigin = "analysis" | "declared";

/** A resource a publication targets. Only queues and buckets publish events. */
export interface PublicationTarget {
  readonly kind: Extract<ResourceKind, "queue" | "bucket">;
  readonly id: string;
}

/** One publication a handler may perform, as found by analysis or declared in `events.publishes`. */
export interface EventPublication {
  /** The publishing handler's identifier. */
  readonly handler: string;
  readonly operation: PublicationOperation;
  /** The resource published to; absent when the certainty is `unknown`. */
  readonly target?: PublicationTarget;
  readonly certainty: PublicationCertainty;
  readonly origin: PublicationOrigin;
  /** The call as written, for example `resources.orders.send()`. Absent for declared publications. */
  readonly call?: string;
  /** Where the call is written, root-relative. */
  readonly location?: DiagnosticLocation;
  /** For object writes and deletes: the key's static beginning, when analysis can read one. */
  readonly keyPrefix?: string;
  /** Whether `keyPrefix` is the whole key (a string literal or a template without substitutions). */
  readonly keyExact?: boolean;
  /** Functions the call is reached through, outermost first, for example `["saveReceipt"]` or `["lib/queue.ts#enqueue"]`. */
  readonly via?: readonly string[];
}

/** How completely analysis covered a handler. */
export type HandlerAnalysisCoverage = "complete" | "partial" | "unavailable";

/** A resource node of the event graph. */
export interface EventGraphResourceNode {
  /** `resource:<id>`. */
  readonly key: string;
  readonly type: "resource";
  readonly id: string;
  readonly kind: ResourceKind;
}

/** A handler node of the event graph, with the event policy it declares. */
export interface EventGraphHandlerNode {
  /** `handler:<id>`. */
  readonly key: string;
  readonly type: "handler";
  readonly id: string;
  readonly trigger: TriggerKind;
  /**
   * `complete` when analysis read the handler's code and resolved every call
   * that looks like a publication; `partial` when some calls stayed
   * unresolved or the handler's code could not be located exactly;
   * `unavailable` when its source was not available or could not be scanned.
   */
  readonly coverage: HandlerAnalysisCoverage;
  /** Where the handler is registered. */
  readonly location?: DiagnosticLocation;
  readonly cycle?: HandlerCycleAllowance;
  readonly maxDepth?: number;
  readonly maxPublications?: number;
}

/** Any node of the event graph. */
export type EventGraphNode = EventGraphResourceNode | EventGraphHandlerNode;

/** The events a resource delivers to a handler. */
export type ConsumedEvent = "queue.message" | "object.created" | "object.deleted" | "schedule.tick" | "http.request";

/** A resource delivers events to a handler: its trigger. */
export interface ConsumptionEdge {
  readonly from: string;
  readonly to: string;
  readonly relation: "consumes";
  readonly event: ConsumedEvent;
  /** For object events: the handler's key prefix filter. */
  readonly prefix?: string;
}

/** A handler publishes to a resource. */
export interface PublicationEdge {
  readonly from: string;
  readonly to: string;
  readonly relation: "publishes";
  readonly operation: PublicationOperation;
  readonly certainty: Exclude<PublicationCertainty, "unknown">;
  readonly origin: PublicationOrigin;
  readonly call?: string;
  readonly location?: DiagnosticLocation;
  readonly keyPrefix?: string;
  readonly keyExact?: boolean;
  readonly via?: readonly string[];
}

/** Any edge of the event graph. */
export type EventGraphEdge = ConsumptionEdge | PublicationEdge;

/**
 * The application's event dependency graph: resources and handlers as nodes,
 * triggers as consumption edges and the publications analysis found or the
 * handlers declared as publication edges. Publications whose target analysis
 * could not resolve are listed in `unresolved` instead of becoming edges.
 */
export interface EventGraph {
  /** Nodes sorted by key. */
  readonly nodes: readonly EventGraphNode[];
  /** Edges sorted by `from`, `to`, relation, then position. */
  readonly edges: readonly EventGraphEdge[];
  /** Calls that look like publications on something analysis could not resolve, sorted by handler and location. */
  readonly unresolved: readonly EventPublication[];
}

/** What {@link buildEventGraph} knows about one handler beyond the manifest. */
export interface HandlerEventFacts {
  readonly coverage: HandlerAnalysisCoverage;
  readonly location?: DiagnosticLocation;
  readonly cycle?: HandlerCycleAllowance;
  readonly maxDepth?: number;
  readonly maxPublications?: number;
}

/** The consumed event of each trigger kind. */
const consumedEventOf: Readonly<Record<TriggerKind, ConsumedEvent>> = {
  "queue.message": "queue.message",
  "bucket.object-created": "object.created",
  "bucket.object-deleted": "object.deleted",
  "schedule.tick": "schedule.tick",
  "http.route": "http.request",
  "http.procedure": "http.request"
};

/**
 * Builds the event dependency graph of a manifest from the publications of
 * its handlers. Deterministic: the same inputs in any order produce the same
 * graph. Publications naming a resource the manifest does not declare, or a
 * handler it does not register, are left out.
 *
 * @param manifest - The application's manifest.
 * @param publications - Publications found by analysis or declared by handlers.
 * @param facts - Coverage, location and declared policy by handler identifier; handlers without facts are `unavailable`.
 * @returns The nodes, edges and unresolved publications, each in a stable order.
 *
 * @example
 * ```ts
 * const graph = buildEventGraph(manifest, [{ handler: "orders.process", operation: "send", target: { kind: "queue", id: "orders" }, certainty: "known", origin: "analysis" }]);
 * ```
 */
export function buildEventGraph(manifest: Manifest, publications: readonly EventPublication[], facts: ReadonlyMap<string, HandlerEventFacts> = new Map()): EventGraph {
  const nodes: EventGraphNode[] = [];
  const edges: EventGraphEdge[] = [];
  const resources = new Map(manifest.resources.map(resource => [resource.id as string, resource.kind]));
  const handlers = new Set(manifest.handlers.map(handler => handler.id as string));
  for (const resource of manifest.resources)
    nodes.push({ key: `resource:${resource.id}`, type: "resource", id: resource.id, kind: resource.kind });
  for (const handler of manifest.handlers) {
    const known = facts.get(handler.id);
    nodes.push({
      key: `handler:${handler.id}`,
      type: "handler",
      id: handler.id,
      trigger: handler.trigger.kind,
      coverage: known?.coverage ?? "unavailable",
      ...known?.location === undefined ? {} : { location: known.location },
      ...known?.cycle === undefined ? {} : { cycle: known.cycle },
      ...known?.maxDepth === undefined ? {} : { maxDepth: known.maxDepth },
      ...known?.maxPublications === undefined ? {} : { maxPublications: known.maxPublications }
    });
    const prefix = "prefix" in handler.trigger.options ? handler.trigger.options.prefix : undefined;
    edges.push({ from: `resource:${handler.trigger.resource.id}`, to: `handler:${handler.id}`, relation: "consumes", event: consumedEventOf[handler.trigger.kind], ...prefix === undefined ? {} : { prefix } });
  }
  const unresolved: EventPublication[] = [];
  const seen = new Set<string>();
  for (const publication of publications) {
    if (!handlers.has(publication.handler))
      continue;
    if (publication.target === undefined || publication.certainty === "unknown") {
      unresolved.push(publication);
      continue;
    }
    if (resources.get(publication.target.id) !== publication.target.kind)
      continue;
    const edge: PublicationEdge = {
      from: `handler:${publication.handler}`,
      to: `resource:${publication.target.id}`,
      relation: "publishes",
      operation: publication.operation,
      certainty: publication.certainty,
      origin: publication.origin,
      ...publication.call === undefined ? {} : { call: publication.call },
      ...publication.location === undefined ? {} : { location: publication.location },
      ...publication.keyPrefix === undefined ? {} : { keyPrefix: publication.keyPrefix, keyExact: publication.keyExact ?? false },
      ...publication.via === undefined || publication.via.length === 0 ? {} : { via: publication.via }
    };
    const identity = JSON.stringify([edge.from, edge.to, edge.operation, edge.certainty, edge.origin, edge.call, edge.location, edge.keyPrefix, edge.via]);
    if (seen.has(identity))
      continue;
    seen.add(identity);
    edges.push(edge);
  }
  nodes.sort((left, right) => compareCodeUnits(left.key, right.key));
  edges.sort(compareEdges);
  unresolved.sort((left, right) => compareCodeUnits(left.handler, right.handler) || compareLocations(left.location, right.location) || compareCodeUnits(left.call ?? "", right.call ?? ""));
  return { nodes, edges, unresolved };
}

/**
 * Orders edges by endpoints, relation, then where they are written.
 *
 * @param left - An edge.
 * @param right - Another edge.
 * @returns A negative number, zero or a positive number.
 */
function compareEdges(left: EventGraphEdge, right: EventGraphEdge): number {
  return compareCodeUnits(left.from, right.from)
    || compareCodeUnits(left.to, right.to)
    || compareCodeUnits(left.relation, right.relation)
    || (left.relation === "publishes" && right.relation === "publishes"
      ? compareCodeUnits(left.operation, right.operation) || compareCodeUnits(left.origin, right.origin) || compareLocations(left.location, right.location) || compareCodeUnits(left.call ?? "", right.call ?? "")
      : 0);
}

/**
 * Orders optional source locations by file, line and column; absent ones first.
 *
 * @param left - A location.
 * @param right - Another location.
 * @returns A negative number, zero or a positive number.
 */
export function compareLocations(left: DiagnosticLocation | undefined, right: DiagnosticLocation | undefined): number {
  if (left === undefined || right === undefined)
    return left === right ? 0 : left === undefined ? -1 : 1;
  return compareCodeUnits(left.file, right.file) || (left.line ?? 0) - (right.line ?? 0) || (left.column ?? 0) - (right.column ?? 0);
}