import { defineBindings } from "@holqa/bindings";
import { container } from "@holqa/container";
import { localEnvironment } from "@holqa/local";

import app from "@test/fixtures/apps/packaged/infra";

/** The container serves HTTP and static files; the local platform, in memory, runs the queue. */
const host = container.host();

export default defineBindings({ ...app, resources: { api: { kind: "http.api", id: "api" }, jobs: { kind: "queue", id: "jobs" }, web: { kind: "static.site", id: "web" } } } as const, {
  name: "production",
  defaults: localEnvironment({ persistence: "memory", telemetry: false }).platform(),
  kinds: { "http.api": host, "static.site": host }
});