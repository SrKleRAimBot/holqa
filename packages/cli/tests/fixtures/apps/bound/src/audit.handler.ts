import { consumer } from "@test/support/descriptors";

/** Consumes the audit queue. */
export default consumer("audit.record", "audit");