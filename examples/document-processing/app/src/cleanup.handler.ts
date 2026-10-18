import {
  env,
  resources
} from "@/app/infra";

/**
 * Removes uploads older than `UPLOAD_TTL_HOURS`, measured from the run's
 * scheduled time so that a late run removes the same objects an on-time run
 * would have. Results and records are kept. The listing is read one bounded
 * page at a time.
 */
export const cleanUpUploads = resources.cleanup.handle({
  id: "uploads.cleanup",
  handler: async ({ scheduledTime, trigger, signal, log }) => {
    const cutoff = Date.parse(scheduledTime) - env.UPLOAD_TTL_HOURS * 3_600_000;
    let cursor: string | undefined;
    let removed = 0;
    do {
      const page = await resources.files.list({ prefix: "uploads/", limit: 100, ...cursor === undefined ? {} : { cursor } });
      for (const object of page.objects) {
        if (signal.aborted)
          return;
        if (Date.parse(object.lastModified) <= cutoff && await resources.files.delete(object.key))
          removed += 1;
      }
      cursor = page.cursor;
    } while (cursor !== undefined);
    log.info("expired uploads removed", { removed, trigger });
  }
});