import { resources } from "../infra";

/** Processes jobs and records each success in the uploads bucket; `fail` modes exercise redelivery. */
export default resources.jobs.consume({
  id: "jobs-consumer",
  concurrency: 2,
  handler: async ({ message, delivery }) => {
    if (message.mode === "fail" || (message.mode === "fail-once" && delivery.attempt === 1))
      throw new Error(`Job ${message.key} failed on attempt ${String(delivery.attempt)}.`);
    await resources.uploads.put(`processed/${message.key}`, String(delivery.attempt));
  }
});