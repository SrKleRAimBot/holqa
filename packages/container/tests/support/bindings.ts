import type { BindingsDefinition } from "@holqa/bindings";

import { defineBindings } from "@holqa/bindings";
import { localEnvironment } from "@holqa/local";

import app from "@test/support/app";
import { container } from "@/host";

/** The host serves HTTP and static files; the local platform, in memory, the rest. */
const host = container.host({ root: import.meta.dir });

/**
 * Creates a fresh binding configuration.
 *
 * @param name - The configuration's name.
 * @returns The configuration.
 */
export function bindings(name = "container-test"): BindingsDefinition<typeof app> {
  return defineBindings(app, { name, defaults: localEnvironment({ persistence: "memory", telemetry: false }).platform(), kinds: { "http.api": host, "static.site": host } });
}