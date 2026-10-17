import type { Manifest } from "@/manifest";

import { canonicalJsonStringify } from "@holqa/compiler";

/**
 * Serializes a manifest to canonical JSON: sorted keys at every depth,
 * two-space indentation and no trailing newline, so that equal manifests are
 * byte-identical.
 *
 * @param manifest - The manifest produced by `compileApp`.
 * @returns The canonical JSON text.
 * @throws {CanonicalJsonError} When the manifest contains a value with no canonical form, such as `undefined` in a descriptor's config.
 */
export function serializeManifest(manifest: Manifest): string {
  return canonicalJsonStringify(manifest);
}