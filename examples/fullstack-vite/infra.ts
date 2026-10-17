// Illustrative example: uses the proposed Holqa API, which is not implemented yet. This file is not type-checked or executed.
import {
  defineApp,
  http,
  secret,
  staticSite
} from "@holqa/sdk";
import { z } from "zod";

/**
 * A Vite single-page app and the typed RPC API it calls. During local
 * development the frontend and backend are planned to share one origin, so the
 * browser calls `/api/rpc` without CORS configuration.
 */
const app = defineApp({
  name: "fullstack-vite",

  handlers: ["./src/**/*.handler.ts"],

  resources: {
    api: http.api({
      id: "public-api",
      basePath: "/api",
      rpc: {
        path: "/rpc"
      }
    }),

    web: staticSite({
      id: "web",
      root: "./web",
      build: {
        command: "bun run build",
        output: "dist"
      },
      spaFallback: true
    })
  },

  env: {
    DATABASE_URL: secret(z.string().min(1))
  }
});

export default app;

/** Typed handles used by the RPC procedure modules in `src/api/`. */
export const resources = app.resources;

/** Validated server-side configuration; never imported by code under `web/`. */
export const config = app.env;