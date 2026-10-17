import { z } from "zod";

import {
  config,
  resources
} from "../infra";
import {
  evaluation,
  nextCall,
  version
} from "../state";

/** Echoes a value with the module state of the generation that served it. */
export default resources.api.route({
  id: "echo",
  method: "POST",
  path: "/echo/:name",
  body: z.object({ value: z.string() }),
  responses: {
    200: z.object({ name: z.string(), value: z.string(), version: z.string(), evaluation: z.number(), call: z.number(), mode: z.string() })
  },
  handler: ({ params, body, reply }) => reply(200, { name: params.name, value: body.value, version, evaluation, call: nextCall(), mode: config.MODE })
});

/** Waits for a number of milliseconds, optionally ignoring cancellation, then reports its generation's state. */
export const sleep = resources.api.route({
  id: "sleep",
  method: "POST",
  path: "/sleep",
  body: z.object({ ms: z.number().int().min(0), ignoreAbort: z.boolean() }),
  responses: { 200: z.object({ version: z.string(), evaluation: z.number() }) },
  handler: async ({ body, signal, reply }) => {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, body.ms);
      if (!body.ignoreAbort) {
        signal.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(signal.reason);
        }, { once: true });
      }
    });
    return reply(200, { version, evaluation });
  }
});