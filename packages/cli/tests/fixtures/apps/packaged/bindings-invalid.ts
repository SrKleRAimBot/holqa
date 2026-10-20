import { defineBindings } from "@holqa/bindings";
import { container } from "@holqa/container";

import app from "@test/fixtures/apps/packaged/infra";

/** Binds nothing but HTTP: the queue and the static site have no provider. */
export default defineBindings({ ...app, resources: { api: { kind: "http.api", id: "api" }, jobs: { kind: "queue", id: "jobs" }, web: { kind: "static.site", id: "web" } } } as const, {
  name: "broken",
  kinds: { "http.api": container.host() }
} as never);