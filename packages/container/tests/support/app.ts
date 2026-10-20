import {
  defineApp,
  http,
  queue,
  staticSite
} from "@holqa/sdk";
import { z } from "zod";

/** An application with an HTTP API, a queue consumed in the background and a static site. */
const app = defineApp({
  name: "shop",
  handlers: ["handlers.ts"],
  resources: {
    api: http.api({ id: "api", basePath: "/api" }),
    jobs: queue({ id: "jobs", message: z.object({ name: z.string() }), schemaVersion: 1 }),
    web: staticSite({ id: "web", directory: "web", spa: true })
  }
});

export default app;

/** Typed handles for the handlers. */
export const resources = app.resources;