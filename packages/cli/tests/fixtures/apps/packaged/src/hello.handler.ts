import { route } from "@test/support/descriptors";

/** Greets. */
export default route("hello", "api", "GET", "/hello", () => Response.json({ hello: "packaged" }));