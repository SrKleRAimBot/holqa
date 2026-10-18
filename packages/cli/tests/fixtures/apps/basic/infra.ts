import {
  application,
  queue,
  secret
} from "@test/support/descriptors";

// Printed during evaluation; the CLI must keep it out of standard output.
console.log("evaluating the basic fixture");

// The analysis process must not see the CLI's secrets.
const { HOLQA_FIXTURE_SECRET: leaked } = process.env;
if (leaked !== undefined)
  throw new Error("The analysis process received a secret from the CLI environment.");

/** A queue with one consumer and one secret. */
export default application("basic", [queue("orders")], [secret("API_TOKEN")]);