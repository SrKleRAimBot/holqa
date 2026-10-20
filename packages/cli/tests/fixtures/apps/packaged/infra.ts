import type { ResourceDescriptor } from "@holqa/core";

import { parseResourceId } from "@holqa/core";
import {
  api,
  application,
  queue
} from "@test/support/descriptors";

/** A static site served from web/, with single-page fallback. */
const web: ResourceDescriptor = { protocol: 1, type: "resource", kind: "static.site", id: (parseResourceId("web") as { readonly value: ResourceDescriptor["id"] }).value, config: { directory: "web", basePath: "/" }, requirements: { spaFallback: true }, schemas: {} };

/** An HTTP API, a queue with a background worker and a static site, packaged by holqa package. */
export default application("packaged", [api("api"), queue("jobs"), web]);