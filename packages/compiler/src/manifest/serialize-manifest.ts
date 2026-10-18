import type { EntrypointMap } from "@/manifest/entrypoints";
import type { Manifest } from "@/manifest/manifest";

import { canonicalJsonStringify } from "@/manifest/canonical-json";

/** The prefix of every manifest fingerprint, naming the hash algorithm. */
export const manifestFingerprintPrefix = "sha256:";

/**
 * Serializes a manifest as canonical JSON: keys sorted at every depth,
 * two-space indentation, no trailing newline. Equal manifests produce equal
 * text on every machine.
 *
 * @param manifest - A manifest produced by `compileApplication` or read with `validateManifest`.
 * @returns The canonical JSON text.
 * @throws {CanonicalJsonError} When the manifest contains a value without a canonical form, which indicates a compiler bug.
 */
export function serializeManifest(manifest: Manifest): string {
  return canonicalJsonStringify(manifest);
}

/**
 * Serializes an entry point map as canonical JSON.
 *
 * @param entrypoints - The entry point map.
 * @returns The canonical JSON text.
 * @throws {CanonicalJsonError} When the map contains a value without a canonical form.
 */
export function serializeEntrypoints(entrypoints: EntrypointMap): string {
  return canonicalJsonStringify(entrypoints);
}

/**
 * Computes a manifest's fingerprint: the SHA-256 of its canonical JSON text.
 * Build metadata such as the entry point map records it to name the exact
 * manifest it belongs to.
 *
 * @param manifest - A manifest produced by `compileApplication` or read with `validateManifest`.
 * @returns `sha256:` followed by 64 lowercase hex digits.
 * @throws {CanonicalJsonError} When the manifest cannot be serialized.
 */
export async function fingerprintManifest(manifest: Manifest): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(serializeManifest(manifest)));
  return `${manifestFingerprintPrefix}${[...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("")}`;
}