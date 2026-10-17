// Illustrative example: uses the proposed Holqa API, which is not implemented yet. This file is not type-checked or executed.
import {
  bucket,
  defineApp,
  http,
  queue,
  schedule,
  secret,
  variable
} from "@holqa/sdk";
import { z } from "zod";

/**
 * The application's resource graph. Each `id` is the stable logical identity
 * of a resource; the property names (`api`, `orders`, ...) are only local
 * TypeScript handles and can be renamed without affecting infrastructure.
 */
const app = defineApp({
  name: "basic-backend",

  handlers: ["./src/**/*.handler.ts"],

  resources: {
    api: http.api({
      id: "public-api",
      basePath: "/api",
      docs: {
        title: "Basic backend API",
        version: "1.0.0"
      }
    }),

    orders: queue({
      id: "order-processing",
      message: z.object({
        orderId: z.string().uuid(),
        priority: z.enum(["normal", "urgent"])
      }),
      schemaVersion: 1,
      delivery: {
        maxAttempts: 5,
        deadLetter: true
      }
    }),

    uploads: bucket({
      id: "customer-uploads",
      access: "private"
    }),

    cleanup: schedule({
      id: "daily-cleanup",
      cron: "0 2 * * *",
      timezone: "UTC",
      overlap: "skip"
    })
  },

  env: {
    DATABASE_URL: secret(z.string().min(1)),
    LOG_LEVEL: variable(
      z.enum(["debug", "info", "warn", "error"]),
      { default: "info" }
    )
  }
});

export default app;

/** Typed handles used by handler modules to send messages and register consumers. */
export const resources = app.resources;

/** Validated environment values; secrets are only readable from server-side handlers. */
export const config = app.env;