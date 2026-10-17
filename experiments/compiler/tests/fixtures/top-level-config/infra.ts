// Fixture: an application whose handler module reads configuration at module top level.
import {
  defineApp,
  queue,
  secret
} from "@holqa/experiment-sdk";
import { z } from "zod";

/** The fixture application. */
const app = defineApp({
  name: "fixture-top-level-config",
  handlers: ["./src/**/*.handler.ts"],
  resources: {
    reports: queue({ id: "reports", message: z.object({ reportId: z.string() }), schemaVersion: 1 })
  },
  env: {
    DATABASE_URL: secret(z.string().min(1))
  }
});

export default app;