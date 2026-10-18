import { queue } from "@holqa/sdk";
import { z } from "zod";

/** A queue that was never added to the application's resources. */
export const refunds = queue({ id: "refund-requested", message: z.object({ refundId: z.string() }), schemaVersion: 1 });