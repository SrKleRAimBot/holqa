// Illustrative example: uses the proposed Holqa API, which is not implemented yet. This file is not type-checked or executed.
import { resources } from "../../infra";
import { sql } from "../db";

/** Number of days a rejected upload record is kept before cleanup removes it. */
const retentionDays = 30;

/**
 * Handler for the `daily-cleanup` schedule (02:00 UTC, `overlap: "skip"`).
 * Uses the scheduled time rather than the wall clock, so a delayed or manually
 * triggered run removes the same rows; running it twice is harmless.
 */
export default resources.cleanup.handle({
  id: "maintenance.daily-cleanup",
  handler: async ({ scheduledTime, log }) => {
    const cutoff = new Date(scheduledTime.getTime() - retentionDays * 24 * 60 * 60 * 1000);

    const removed = await sql`DELETE FROM uploads WHERE status = 'rejected' AND created_at < ${cutoff} RETURNING object_key`;

    log.info("Removed expired upload records", { count: removed.length, cutoff: cutoff.toISOString() });
  }
});