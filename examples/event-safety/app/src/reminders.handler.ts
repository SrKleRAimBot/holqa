import { resources } from "@/app/infra";

/**
 * Sends a reminder and schedules a follow-up. Together with
 * `followups.send` it forms an indirect cycle without a termination
 * condition: `holqa inspect --cycles` warns about it, and the runtime's depth
 * limit stops it.
 */
export const sendReminder = resources.reminders.consume({
  id: "reminders.send",
  handler: async ({ message, log }) => {
    log.info("reminder sent", { customerId: message.customerId, count: message.count });
    await resources.followups.send({ customerId: message.customerId, count: message.count + 1 });
  }
});

/** Follows up on a reminder by sending another one. */
export const sendFollowup = resources.followups.consume({
  id: "followups.send",
  handler: async ({ message }) => {
    const { reminders } = resources;
    await reminders.send(message);
  }
});