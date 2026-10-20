import {
  application,
  queue,
  secret
} from "@test/support/descriptors";

/** A queue with one consumer and one secret, bound by bindings.ts. */
export default application("bound", [queue("orders"), queue("audit")], [secret("API_TOKEN")]);