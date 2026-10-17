import {
  bucket,
  defineApp,
  http,
  queue,
  secret,
  variable
} from "@holqa/experiment-sdk";
import { z } from "zod";

/** Runtime test fixture: one API, two queues, one bucket and two configuration entries. */
const app = defineApp({
  name: "runtime-fixture",
  handlers: ["./handlers/**/*.handler.ts"],
  resources: {
    api: http.api({ id: "api", basePath: "/api" }),
    jobs: queue({
      id: "jobs",
      message: z.object({ key: z.string(), mode: z.enum(["ok", "fail", "fail-once"]) }),
      schemaVersion: 1,
      delivery: { maxAttempts: 3, deadLetter: true }
    }),
    gated: queue({
      id: "gated",
      message: z.object({ key: z.string(), ignoreAbort: z.boolean() }),
      schemaVersion: 1
    }),
    uploads: bucket({ id: "uploads", access: "private" })
  },
  env: {
    TOKEN: secret(z.string().min(8)),
    MODE: variable(z.enum(["a", "b"]), { default: "a" })
  }
});

export default app;

/** Typed resource handles for the fixture's handlers. */
export const resources = app.resources;

/** Validated configuration for the fixture's handlers. */
export const config = app.env;