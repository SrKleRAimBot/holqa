import {
  application,
  queue
} from "@test/support/descriptors";

/** An application whose handler modules are broken in two ways. */
export default application("broken", [queue("orders")]);