import {
  bucket,
  defineApp,
  queue
} from "@holqa/sdk";
import {
  charge,
  reminder,
  shipment
} from "@/app/src/contracts";

/** Three attempts, one second apart; exhausted messages are kept for inspection and redrive. */
const delivery = { maxAttempts: 3, deadLetter: true, backoff: { strategy: "fixed" as const, delaySeconds: 1 } };

/**
 * Event-driven handlers chosen to show what event safety analysis and the
 * runtime's limits do: an intentional, terminating cycle (shipments that
 * wait for stock), an unintended indirect cycle (reminders and follow-ups
 * that trigger each other), object writes that cannot trigger their own
 * handler (thumbnails), and idempotent payment processing.
 */
const app = defineApp({
  name: "event-safety",
  description: "Event safety example: cycles, limits and idempotency.",
  handlers: ["src/**/*.handler.ts"],
  resources: {
    shipments: queue({ id: "shipments", message: shipment, schemaVersion: 1, delivery }),
    reminders: queue({ id: "reminders", message: reminder, schemaVersion: 1, delivery }),
    followups: queue({ id: "followups", message: reminder, schemaVersion: 1, delivery }),
    payments: queue({ id: "payments", message: charge, schemaVersion: 1, delivery }),
    images: bucket({ id: "images", access: "private" })
  }
});

export default app;

/** Typed handles for handler modules. */
export const resources = app.resources;