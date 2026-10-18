import type {
  ResourceKind,
  TriggerKind
} from "@holqa/core";

import type {
  Manifest,
  ManifestSchemaReferences
} from "@/manifest/manifest";

import { normalizeResourceKind } from "@/analysis/kinds";
import { compareCodeUnits } from "@/discovery/module-path";

/** A node of the resource graph. `key` is unique: `<type>:<identity>`. */
export type GraphNode
  = | { readonly key: string; readonly type: "application"; readonly id: string }
    | { readonly key: string; readonly type: "resource"; readonly id: string; readonly kind: ResourceKind; readonly capabilities: readonly string[] }
    | { readonly key: string; readonly type: "handler"; readonly id: string; readonly trigger: TriggerKind }
    | { readonly key: string; readonly type: "config"; readonly id: string; readonly kind: "secret" | "variable" }
    | { readonly key: string; readonly type: "schema"; readonly id: string };

/**
 * How two nodes are related. Only relationships that the declarations state
 * explicitly are recorded:
 *
 * - `declares`: the application declares a resource;
 * - `registers`: the application's handler discovery found a handler;
 * - `requires`: the application requires a configuration entry (an environment binding);
 * - `triggers`: a resource invokes a handler;
 * - `schema`: a resource, handler or configuration entry uses a schema contract in a role.
 *
 * Which resources a handler calls at run time (for example `send` on another
 * queue) is not derivable from declarations and is not recorded.
 */
export type GraphRelation = "declares" | "registers" | "requires" | "triggers" | "schema";

/** A directed, labelled edge between two node keys. */
export interface GraphEdge {
  readonly from: string;
  readonly to: string;
  readonly relation: GraphRelation;
  /** The schema role (for `schema` edges) or trigger kind (for `triggers` edges). */
  readonly label?: string;
}

/** The application's resource graph: nodes and edges, both in a stable order. */
export interface ResourceGraph {
  /** Nodes sorted by key. */
  readonly nodes: readonly GraphNode[];
  /** Edges sorted by `from`, `to`, `relation`, then `label`. */
  readonly edges: readonly GraphEdge[];
}

/**
 * Builds the resource graph of a manifest: the application, its resources,
 * handlers, configuration entries and schema contracts, and the explicit
 * relationships between them. The graph is derived from the manifest alone,
 * so tools can inspect an application's intended infrastructure from a
 * `manifest.json` without loading its code.
 *
 * @param manifest - A manifest, for example from `compileApplication` or `validateManifest`.
 * @returns The graph, deterministic for a given manifest.
 *
 * @example
 * ```ts
 * const graph = buildResourceGraph(manifest);
 * graph.edges.filter(edge => edge.relation === "triggers");
 * ```
 */
export function buildResourceGraph(manifest: Manifest): ResourceGraph {
  const application = `application:${manifest.application.name}`;
  const nodes: GraphNode[] = [{ key: application, type: "application", id: manifest.application.name }];
  const edges: GraphEdge[] = [];

  /**
   * Adds one `schema` edge per schema reference.
   *
   * @param from - The using node.
   * @param schemas - Its schema references by role.
   */
  const schemaEdges = (from: string, schemas: ManifestSchemaReferences): void => {
    for (const [role, reference] of Object.entries(schemas))
      edges.push({ from, to: `schema:${reference.fingerprint}`, relation: "schema", label: role });
  };

  for (const resource of manifest.resources) {
    const key = `resource:${resource.id}`;
    const { capabilities } = normalizeResourceKind(resource.kind, resource.config, resource.requirements);
    nodes.push({ key, type: "resource", id: resource.id, kind: resource.kind, capabilities: [...capabilities].sort(compareCodeUnits) });
    edges.push({ from: application, to: key, relation: "declares" });
    schemaEdges(key, resource.schemas);
  }
  for (const handler of manifest.handlers) {
    const key = `handler:${handler.id}`;
    nodes.push({ key, type: "handler", id: handler.id, trigger: handler.trigger.kind });
    edges.push({ from: application, to: key, relation: "registers" });
    edges.push({ from: `resource:${handler.trigger.resource.id}`, to: key, relation: "triggers", label: handler.trigger.kind });
    schemaEdges(key, handler.schemas);
  }
  for (const entry of manifest.config) {
    const key = `config:${entry.name}`;
    nodes.push({ key, type: "config", id: entry.name, kind: entry.kind });
    edges.push({ from: application, to: key, relation: "requires" });
    schemaEdges(key, { value: entry.schema });
  }
  for (const fingerprint of Object.keys(manifest.schemas))
    nodes.push({ key: `schema:${fingerprint}`, type: "schema", id: fingerprint });

  nodes.sort((left, right) => compareCodeUnits(left.key, right.key));
  edges.sort((left, right) => compareCodeUnits(left.from, right.from)
    || compareCodeUnits(left.to, right.to)
    || compareCodeUnits(left.relation, right.relation)
    || compareCodeUnits(left.label ?? "", right.label ?? ""));
  return { nodes, edges };
}