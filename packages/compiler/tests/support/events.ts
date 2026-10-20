import type {
  AppDescriptor,
  Described,
  HandlerDescriptor,
  HandlerEventPolicy,
  ResourceDescriptor
} from "@holqa/core";

import type {
  CompileApplicationInput,
  EvaluatedModule
} from "@/index";

import {
  application,
  bucketResource,
  described,
  fixtureAdapter,
  fixtureSchema,
  module,
  queueResource
} from "@test/support/application";

/** The message schema every test queue uses. */
export const message = fixtureSchema({ type: "object" });

/**
 * Declares a queue and its handle.
 *
 * @param id - The queue's identifier.
 * @returns The descriptor and the handle that carries it.
 */
export function queueHandle(id: string): { readonly resource: ResourceDescriptor; readonly handle: Described<ResourceDescriptor> } {
  const resource = queueResource(id, message);
  return { resource, handle: described(resource) };
}

/**
 * Declares a bucket and its handle.
 *
 * @param id - The bucket's identifier.
 * @returns The descriptor and the handle that carries it.
 */
export function bucketHandle(id: string): { readonly resource: ResourceDescriptor; readonly handle: Described<ResourceDescriptor> } {
  const resource = bucketResource(id);
  return { resource, handle: described(resource) };
}

/**
 * Returns a handler registration with an event policy added to its definition.
 *
 * @param registration - A registration built by the application support helpers.
 * @param events - The policy.
 * @returns A new registration.
 */
export function withEvents(registration: Described<HandlerDescriptor>, events: HandlerEventPolicy | Readonly<Record<string, unknown>>): Described<HandlerDescriptor> {
  const descriptor = registration["~holqa"];
  return described({ ...descriptor, definition: { ...descriptor.definition, events } } as HandlerDescriptor);
}

/** An application under event analysis: its resources by alias, handler modules and their sources. */
export interface EventFixture {
  /** Resource handles by alias, exported from `infra.ts` as `resources`. */
  readonly resources: Readonly<Record<string, { readonly resource: ResourceDescriptor; readonly handle: Described<ResourceDescriptor> }>>;
  /** Handler modules: their exports and source text. */
  readonly modules: ReadonlyArray<{ readonly path: string; readonly exports: Readonly<Record<string, unknown>>; readonly source: string }>;
  /** Further sources, such as helper modules that are not handler modules. */
  readonly sources?: Readonly<Record<string, string>>;
}

/** The source of the fixture's `infra.ts`. */
const infraSource = "import { defineApp } from \"@holqa/sdk\";\nconst app = defineApp({ name: \"shop\" });\nexport default app;\nexport const resources = app.resources;";

/**
 * Builds the compiler input of an event fixture.
 *
 * @param fixture - Resources, modules and sources.
 * @returns The compile input, with sources and app exports.
 */
export function eventInput(fixture: EventFixture): CompileApplicationInput {
  const app: Described<AppDescriptor> = application({ resources: Object.values(fixture.resources).map(entry => entry.resource), include: ["src/**/*.ts"] });
  const handles = Object.fromEntries(Object.entries(fixture.resources).map(([alias, entry]) => [alias, entry.handle]));
  const modules: EvaluatedModule[] = fixture.modules.map(entry => module(entry.path, entry.exports));
  return {
    app,
    appModule: "infra.ts",
    runtime: "bun",
    adapters: [fixtureAdapter],
    modules,
    appExports: { resources: handles },
    sources: { "infra.ts": infraSource, ...Object.fromEntries(fixture.modules.map(entry => [entry.path, entry.source])), ...fixture.sources }
  };
}