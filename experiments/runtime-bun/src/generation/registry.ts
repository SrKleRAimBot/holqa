import type { Result } from "@holqa/core";
import type {
  HandlerDescriptor,
  JsonObject,
  ResourceDescriptor,
  TriggerDescriptor
} from "@holqa/experiment-model";

import type { RuntimeDiagnostic } from "@/diagnostics";
import type { LoadedGraph } from "@/generation/load-graph";

import {
  err,
  ok,
  parseResourceId
} from "@holqa/core";
import {
  descriptorKey,
  experimentCodes,
  getDescriptor
} from "@holqa/experiment-model";

import { runtimeError } from "@/diagnostics";

/** JSON metadata about a registered handler, safe to send across a worker boundary. */
export interface HandlerInfo {
  readonly id: string;
  readonly trigger: TriggerDescriptor;
  readonly config: JsonObject;
  /** The handler module, relative to the application root. */
  readonly module: string;
}

/** JSON metadata about a declared resource. */
export interface ResourceInfo {
  readonly id: string;
  readonly kind: string;
  readonly config: JsonObject;
}

/** A validated set of handlers and resources for one generation. */
export interface Registry {
  readonly handlers: ReadonlyMap<string, { readonly info: HandlerInfo; readonly descriptor: HandlerDescriptor }>;
  readonly resources: ReadonlyMap<string, ResourceInfo>;
}

/**
 * Validates an evaluated module graph and builds its handler registry. Every
 * problem is reported; a registry is returned only when there are none, so a
 * failed load never registers a partial set of handlers.
 *
 * Checks: resource identifier grammar and uniqueness, descriptor protocol
 * versions of exported values, handler identifier uniqueness, references to
 * undeclared resources, and at most one consumer per queue.
 *
 * @param graph - The evaluated application and handler modules.
 * @returns The registry, or every diagnostic found.
 */
export function buildRegistry(graph: LoadedGraph): Result<Registry, RuntimeDiagnostic[]> {
  const diagnostics: RuntimeDiagnostic[] = [];
  const resources = new Map<string, ResourceInfo>();
  for (const resource of graph.app.resources)
    addResource(resource, resources, diagnostics);

  const handlers = new Map<string, { info: HandlerInfo; descriptor: HandlerDescriptor }>();
  const seen = new Set<HandlerDescriptor>();
  const consumers = new Map<string, string>();
  for (const module of graph.modules) {
    for (const exportName of Object.keys(module.exports).sort()) {
      const value = module.exports[exportName];
      const descriptor = getDescriptor(value);
      if (descriptor === undefined) {
        if ((typeof value === "object" || typeof value === "function") && value !== null && descriptorKey in value)
          diagnostics.push(runtimeError(experimentCodes.declarationInvalid, `Export "${exportName}" uses an unknown Holqa descriptor protocol.`, { file: module.path, hint: "Align the versions of the Holqa packages the application uses." }));
        continue;
      }
      if (descriptor.type !== "handler" || seen.has(descriptor))
        continue;
      seen.add(descriptor);

      const existing = handlers.get(descriptor.id);
      if (existing !== undefined) {
        diagnostics.push(runtimeError(experimentCodes.handlerIdDuplicate, `Handler "${descriptor.id}" is registered in both ${existing.info.module} and ${module.path}.`, { file: module.path }));
        continue;
      }
      if (!resources.has(descriptor.trigger.resource))
        diagnostics.push(runtimeError(experimentCodes.resourceNotFound, `Handler "${descriptor.id}" refers to undeclared resource "${descriptor.trigger.resource}".`, { file: module.path }));
      if (descriptor.trigger.kind === "queue.message") {
        const other = consumers.get(descriptor.trigger.resource);
        if (other !== undefined)
          diagnostics.push(runtimeError(experimentCodes.queueConsumerDuplicate, `Queue "${descriptor.trigger.resource}" has two consumers: "${other}" and "${descriptor.id}".`, { file: module.path, hint: "A queue has a single competing consumer; use a topic for fan-out." }));
        consumers.set(descriptor.trigger.resource, descriptor.id);
      }
      handlers.set(descriptor.id, { info: { id: descriptor.id, trigger: descriptor.trigger, config: descriptor.config, module: module.path }, descriptor });
    }
  }
  return diagnostics.length > 0 ? err(diagnostics) : ok({ handlers, resources });
}

/**
 * Validates one resource declaration and adds it to the resource table.
 *
 * @param resource - The resource descriptor.
 * @param resources - The table being built.
 * @param diagnostics - Receives any problems.
 */
function addResource(resource: ResourceDescriptor, resources: Map<string, ResourceInfo>, diagnostics: RuntimeDiagnostic[]): void {
  const parsed = parseResourceId(resource.id);
  if (!parsed.ok) {
    diagnostics.push(parsed.error);
    return;
  }
  if (resources.has(resource.id)) {
    diagnostics.push(runtimeError(experimentCodes.resourceIdDuplicate, `Resource identifier "${resource.id}" is declared more than once.`));
    return;
  }
  resources.set(resource.id, { id: resource.id, kind: resource.kind, config: resource.config });
}