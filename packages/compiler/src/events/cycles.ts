import type {
  Diagnostic,
  DiagnosticLocation,
  JsonObject
} from "@holqa/core";

import type {
  ConsumptionEdge,
  EventGraph,
  EventGraphHandlerNode,
  PublicationEdge,
  PublicationOperation
} from "@/events/event-graph";

import {
  createDiagnostic,
  diagnosticCodes
} from "@holqa/core";

import { compareCodeUnits } from "@/discovery/module-path";
import { compareLocations } from "@/events/event-graph";

/** One hop of a cycle: a handler publishes to a resource, which triggers the next handler of the path. */
export interface EventCycleStep {
  /** The publishing handler. */
  readonly handler: string;
  /** The resource it publishes to. */
  readonly resource: string;
  readonly operation: PublicationOperation;
  /** `potential` when the publication is, or when the next handler's key prefix may not match the written key. */
  readonly certainty: "known" | "potential";
  readonly call?: string;
  readonly location?: DiagnosticLocation;
}

/** A justification that permits a cycle. */
export interface CycleAllowance {
  readonly handler: string;
  readonly justification: string;
}

/**
 * A set of handlers that can trigger each other (a strongly connected
 * component of the handler graph), with one representative cycle.
 *
 * `reported` cycles avoid every handler that declares an allowance and
 * become `HOLQA_EVENT_CYCLE` diagnostics: warnings when the representative
 * cycle consists of known publications only, information otherwise.
 * `allowed` cycles pass through at least one handler whose `events.cycle`
 * explains why it terminates; they produce no diagnostic.
 */
export interface EventCycle {
  readonly status: "reported" | "allowed";
  readonly certainty: "known" | "potential";
  /** Every handler of the component, sorted. */
  readonly handlers: readonly string[];
  /** One cycle: `path[i].handler` publishes to `path[i].resource`, which triggers `path[i + 1].handler`; the last step leads back to the first handler. */
  readonly path: readonly EventCycleStep[];
  /** For allowed cycles: the allowances on the component's handlers, sorted by handler. */
  readonly allowedBy?: readonly CycleAllowance[];
}

/** An edge of the handler graph. */
interface HandlerEdge {
  readonly to: string;
  readonly step: EventCycleStep;
}

/** Which consumed event each publication operation causes. */
const eventOf: Readonly<Record<PublicationOperation, ConsumptionEdge["event"]>> = { send: "queue.message", put: "object.created", delete: "object.deleted" };

/**
 * Finds the event cycles of an event graph: direct (a handler triggers
 * itself) and indirect (handlers trigger each other through other
 * resources), using strongly connected components. Cycles are classified by
 * certainty, and cycles through handlers that declare an allowance are
 * reported as allowed. Deterministic for a given graph.
 *
 * The analysis cannot tell whether a cycle terminates: application logic may
 * stop it (a terminal state, a counter). Cycles are therefore findings to
 * review, not errors.
 *
 * @param graph - The event graph from `buildEventGraph`.
 * @returns The cycles, reported ones first, each group sorted by its first handler.
 */
export function analyzeEventCycles(graph: EventGraph): EventCycle[] {
  const handlers = new Map<string, EventGraphHandlerNode>();
  for (const node of graph.nodes) {
    if (node.type === "handler")
      handlers.set(node.id, node);
  }
  const adjacency = handlerEdges(graph);
  const allowed = new Set([...handlers.values()].filter(handler => handler.cycle !== undefined).map(handler => handler.id));
  const all = [...handlers.keys()].sort(compareCodeUnits);

  const cycles: EventCycle[] = [];
  for (const component of components(all.filter(id => !allowed.has(id)), adjacency)) {
    const cycle = representative(component, adjacency);
    if (cycle !== undefined)
      cycles.push({ status: "reported", certainty: cycle.certainty, handlers: component, path: cycle.path });
  }
  for (const component of components(all, adjacency)) {
    const through = component.filter(id => allowed.has(id));
    if (through.length === 0)
      continue;
    const cycle = representative(component, adjacency, through[0]);
    if (cycle === undefined)
      continue;
    cycles.push({
      status: "allowed",
      certainty: cycle.certainty,
      handlers: component,
      path: cycle.path,
      allowedBy: through.map(handler => ({ handler, justification: handlers.get(handler)!.cycle!.justification }))
    });
  }
  return cycles.sort((left, right) => left.status === right.status
    ? compareCodeUnits(left.handlers[0]!, right.handlers[0]!)
    : left.status === "reported" ? -1 : 1);
}

/**
 * Converts reported cycles into `HOLQA_EVENT_CYCLE` diagnostics: warnings
 * for known cycles, information for potential ones. Allowed cycles produce none.
 *
 * @param cycles - The cycles from {@link analyzeEventCycles}.
 * @param graph - The graph they were found in, for handler locations.
 * @returns One diagnostic per reported cycle.
 */
export function eventCycleDiagnostics(cycles: readonly EventCycle[], graph: EventGraph): Diagnostic[] {
  const locations = new Map<string, DiagnosticLocation>();
  for (const node of graph.nodes) {
    if (node.type === "handler" && node.location !== undefined)
      locations.set(node.id, node.location);
  }
  return cycles.filter(cycle => cycle.status === "reported").map((cycle) => {
    const single = cycle.handlers.length === 1;
    const location = cycle.path.find(step => step.location !== undefined)?.location ?? locations.get(cycle.path[0]!.handler);
    return createDiagnostic({
      code: diagnosticCodes.eventCycle,
      severity: cycle.certainty === "known" ? "warning" : "info",
      message: `${cycle.certainty === "known" ? "Event cycle" : "Potential event cycle"}: ${describeCyclePath(cycle.path)}. ${single ? "The handler may publish events that trigger itself" : `The handlers ${cycle.handlers.map(id => `"${id}"`).join(", ")} may publish events that trigger each other`}${cycle.certainty === "known" ? "" : " (some of these publications are uncertain)"}.`,
      ...location === undefined ? {} : { location },
      hint: "Add a termination condition, or bound the chain with events.maxDepth on the handler or the runtime's event limits. If the cycle is intentional, declare events: { cycle: { justification } } on one of its handlers.",
      details: {
        certainty: cycle.certainty,
        handlers: [...cycle.handlers],
        path: cycle.path.map(step => ({
          handler: step.handler,
          resource: step.resource,
          operation: step.operation,
          certainty: step.certainty,
          ...step.call === undefined ? {} : { call: step.call },
          ...step.location === undefined ? {} : { location: { ...step.location } }
        }) satisfies JsonObject)
      }
    });
  });
}

/**
 * Renders a cycle as `a → call() → b → call() → a`.
 *
 * @param path - The cycle's steps.
 * @returns The rendering.
 */
export function describeCyclePath(path: readonly EventCycleStep[]): string {
  const parts: string[] = [];
  for (const step of path)
    parts.push(step.handler, step.call ?? `${step.operation} on "${step.resource}" (declared)`);
  parts.push(path[0]!.handler);
  return parts.join(" → ");
}

/**
 * Derives handler-to-handler edges: a publication to a resource leads to
 * every handler that consumes the event it causes there. For object events
 * the written key must be able to match the handler's prefix; when analysis
 * cannot tell, the edge is potential.
 *
 * @param graph - The event graph.
 * @returns Outgoing edges by handler, sorted by target, certainty and location.
 */
function handlerEdges(graph: EventGraph): Map<string, HandlerEdge[]> {
  const consumers = new Map<string, ConsumptionEdge[]>();
  const publications: PublicationEdge[] = [];
  for (const edge of graph.edges) {
    if (edge.relation === "consumes")
      consumers.set(edge.from, [...consumers.get(edge.from) ?? [], edge]);
    else
      publications.push(edge);
  }
  const adjacency = new Map<string, HandlerEdge[]>();
  for (const publication of publications) {
    for (const consumer of consumers.get(publication.to) ?? []) {
      if (consumer.event !== eventOf[publication.operation])
        continue;
      const match = prefixMatch(consumer.prefix, publication.keyPrefix, publication.keyExact ?? false);
      if (match === "never")
        continue;
      const from = publication.from.slice("handler:".length);
      const step: EventCycleStep = {
        handler: from,
        resource: publication.to.slice("resource:".length),
        operation: publication.operation,
        certainty: publication.certainty === "known" && match === "always" ? "known" : "potential",
        ...publication.call === undefined ? {} : { call: publication.call },
        ...publication.location === undefined ? {} : { location: publication.location }
      };
      adjacency.set(from, [...adjacency.get(from) ?? [], { to: consumer.to.slice("handler:".length), step }]);
    }
  }
  for (const edges of adjacency.values()) {
    edges.sort((left, right) => compareCodeUnits(left.to, right.to)
      || (left.step.certainty === right.step.certainty ? 0 : left.step.certainty === "known" ? -1 : 1)
      || compareLocations(left.step.location, right.step.location));
  }
  return adjacency;
}

/**
 * Decides whether an object key can match a handler's prefix filter.
 *
 * @param prefix - The handler's prefix; absent means every key.
 * @param keyPrefix - The key's static beginning, when known.
 * @param exact - Whether `keyPrefix` is the whole key.
 * @returns `always`, `maybe` or `never`.
 */
function prefixMatch(prefix: string | undefined, keyPrefix: string | undefined, exact: boolean): "always" | "maybe" | "never" {
  if (prefix === undefined || prefix === "")
    return "always";
  if (keyPrefix === undefined)
    return "maybe";
  if (keyPrefix.startsWith(prefix))
    return "always";
  if (!exact && prefix.startsWith(keyPrefix))
    return "maybe";
  return "never";
}

/**
 * Finds the strongly connected components (Tarjan's algorithm) among some
 * handlers that contain a cycle: more than one handler, or one handler with
 * an edge to itself.
 *
 * @param nodes - The handlers to consider, sorted.
 * @param adjacency - Outgoing edges by handler; edges to handlers outside `nodes` are ignored.
 * @returns The cyclic components, each sorted, ordered by their first handler.
 */
function components(nodes: readonly string[], adjacency: ReadonlyMap<string, readonly HandlerEdge[]>): string[][] {
  const included = new Set(nodes);
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const found: string[][] = [];
  let counter = 0;
  /**
   * Visits a handler and the handlers reachable from it.
   *
   * @param node - The handler to visit.
   */
  const visit = (node: string): void => {
    index.set(node, counter);
    low.set(node, counter);
    counter += 1;
    stack.push(node);
    onStack.add(node);
    for (const { to } of adjacency.get(node) ?? []) {
      if (!included.has(to))
        continue;
      if (!index.has(to)) {
        visit(to);
        low.set(node, Math.min(low.get(node)!, low.get(to)!));
      } else if (onStack.has(to)) {
        low.set(node, Math.min(low.get(node)!, index.get(to)!));
      }
    }
    if (low.get(node) !== index.get(node))
      return;
    const component: string[] = [];
    let member: string;
    do {
      member = stack.pop()!;
      onStack.delete(member);
      component.push(member);
    } while (member !== node);
    if (component.length > 1 || (adjacency.get(node) ?? []).some(edge => edge.to === node))
      found.push(component.sort(compareCodeUnits));
  };
  for (const node of nodes) {
    if (!index.has(node))
      visit(node);
  }
  return found.sort((left, right) => compareCodeUnits(left[0]!, right[0]!));
}

/**
 * Picks one shortest cycle of a component, preferring a cycle of known
 * edges: through `start` when given, otherwise through the first handler
 * that lies on a known cycle, otherwise through the component's first handler.
 *
 * @param component - The component's handlers, sorted.
 * @param adjacency - Outgoing edges by handler.
 * @param start - A handler the cycle must pass through.
 * @returns The cycle and its certainty, or `undefined` when none passes through `start`.
 */
function representative(component: readonly string[], adjacency: ReadonlyMap<string, readonly HandlerEdge[]>, start?: string): { readonly path: EventCycleStep[]; readonly certainty: "known" | "potential" } | undefined {
  const members = new Set(component);
  const candidates = start === undefined ? component : [start];
  for (const knownOnly of [true, false]) {
    for (const node of candidates) {
      const path = shortestCycle(node, members, adjacency, knownOnly);
      if (path !== undefined)
        return { path, certainty: path.every(step => step.certainty === "known") ? "known" : "potential" };
    }
  }
  return undefined;
}

/**
 * Finds a shortest cycle through one handler with a breadth-first search.
 *
 * @param start - The handler the cycle passes through.
 * @param members - The handlers the cycle may use.
 * @param adjacency - Outgoing edges by handler.
 * @param knownOnly - Whether only known edges may be used.
 * @returns The cycle's steps starting at `start`, or `undefined` when there is none.
 */
function shortestCycle(start: string, members: ReadonlySet<string>, adjacency: ReadonlyMap<string, readonly HandlerEdge[]>, knownOnly: boolean): EventCycleStep[] | undefined {
  const parent = new Map<string, { readonly from: string; readonly step: EventCycleStep }>();
  const queue = [start];
  for (let head = 0; head < queue.length; head++) {
    const node = queue[head]!;
    for (const edge of adjacency.get(node) ?? []) {
      if (!members.has(edge.to) || (knownOnly && edge.step.certainty !== "known"))
        continue;
      if (edge.to === start) {
        const path = [edge.step];
        let current = node;
        while (current !== start) {
          const previous = parent.get(current)!;
          path.unshift(previous.step);
          current = previous.from;
        }
        return path;
      }
      if (parent.has(edge.to))
        continue;
      parent.set(edge.to, { from: node, step: edge.step });
      queue.push(edge.to);
    }
  }
  return undefined;
}