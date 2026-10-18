import {
  env,
  resources
} from "@/app/infra";

/**
 * Removes uploads older than `UPLOAD_RETENTION_HOURS`, measured from the
 * run's scheduled time so a late run removes what an on-time run would have.
 */
export const removeOldUploads = resources.cleanup.handle({
  id: "cleanup.run",
  handler: async ({ scheduledTime, signal, log }) => {
    const cutoff = Date.parse(scheduledTime) - Number(env.UPLOAD_RETENTION_HOURS) * 3_600_000;
    let cursor: string | undefined;
    let removed = 0;
    do {
      const page = await resources.uploads.list({ limit: 100, ...cursor === undefined ? {} : { cursor } });
      for (const object of page.objects) {
        if (signal.aborted)
          return;
        if (Date.parse(object.lastModified) <= cutoff && await resources.uploads.delete(object.key))
          removed += 1;
      }
      cursor = page.cursor;
    } while (cursor !== undefined);
    log.info("old uploads removed", { removed });
  }
});