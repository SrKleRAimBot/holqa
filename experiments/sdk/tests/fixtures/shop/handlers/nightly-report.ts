import { resources } from "@test/fixtures/shop/infra";

/** Runs every night; reads the scheduled time rather than the clock. */
export default resources.nightly.handle({
  id: "reports.nightly",
  handler: ({ scheduledTime }) => {
    scheduledTime.slice(0, 10);
  }
});