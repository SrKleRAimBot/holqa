import { resources } from "@test/support/app";

import { z } from "zod";

/** Names of processed jobs, in order. */
export const processed: string[] = [];

/** Greets. */
export const hello = resources.api.route({
  id: "hello",
  method: "GET",
  path: "/hello",
  responses: { 200: z.object({ hello: z.string() }) },
  handler: async ({ reply }) => reply(200, { hello: "world" })
});

/** Queues a job. */
export const enqueue = resources.api.route({
  id: "enqueue",
  method: "POST",
  path: "/jobs/:name",
  params: z.object({ name: z.string() }),
  responses: { 202: z.object({ queued: z.string() }) },
  handler: async ({ params, reply }) => {
    await resources.jobs.send({ name: params.name });
    return reply(202, { queued: params.name });
  }
});

/** Processes jobs in the background. */
export const work = resources.jobs.consume({
  id: "jobs.work",
  handler: async ({ message }) => {
    processed.push(message.name);
  }
});