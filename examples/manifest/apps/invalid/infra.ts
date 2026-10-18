import {
  defineApp,
  queue,
  secret
} from "@holqa/sdk";
import { z } from "zod";

/** An application with three deliberate mistakes in its handler modules. */
const app = defineApp({
  name: "payments",
  handlers: ["src/*.handler.ts"],
  resources: {
    payments: queue({ id: "payment-received", message: z.object({ paymentId: z.string() }), schemaVersion: 1 })
  },
  env: {
    DATABASE_URL: secret(z.string().min(1))
  }
});

export default app;

/** Typed handles for handler modules. */
export const resources = app.resources;

/** Typed configuration values. */
export const env = app.env;