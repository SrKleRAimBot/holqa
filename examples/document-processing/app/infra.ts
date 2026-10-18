import {
  bucket,
  defineApp,
  http,
  queue,
  schedule,
  variable
} from "@holqa/sdk";
import { z } from "zod";
import { documentJob } from "@/app/src/contracts";

/**
 * Document processing: an HTTP API accepts uploads, the bucket reports new
 * uploads, a queue hands them to a background processor, and an hourly
 * schedule removes expired uploads. The declarations say what each resource
 * requires; the binding (here the local one) decides how it is fulfilled.
 */
const app = defineApp({
  name: "documents",
  description: "Reference application for event-driven resources.",
  handlers: ["src/**/*.handler.ts"],
  resources: {
    api: http.api({ id: "documents-api", basePath: "/api" }),
    files: bucket({ id: "document-files", access: "private" }),
    jobs: queue({
      id: "document-jobs",
      message: documentJob,
      schemaVersion: 1,
      // Three attempts, 2 s then 4 s apart; exhausted jobs are kept for inspection.
      delivery: { maxAttempts: 3, deadLetter: true, backoff: { strategy: "exponential", initialDelaySeconds: 2, maxDelaySeconds: 30 } }
    }),
    cleanup: schedule({ id: "upload-cleanup", cron: "0 * * * *", timezone: "UTC", overlap: "skip" })
  },
  env: {
    UPLOAD_TTL_HOURS: variable(z.coerce.number().int().positive(), { default: "24" })
  }
});

export default app;

/** Typed handles for handler modules. */
export const resources = app.resources;

/** Typed configuration values, readable only inside a runtime. */
export const env = app.env;