import type {
  ContractRole,
  Manifest,
  ManifestSchemaReferences,
  SchemaContractRecord
} from "@holqa/compiler";
import type { Diagnostic } from "@holqa/core";

import {
  canonicalJsonStringify,
  checkSchemaCompatibility
} from "@holqa/compiler";

/**
 * What a rebuild changed, from the cheapest to the most far-reaching:
 *
 * - `initial`: the first build of the session.
 * - `implementation`: the manifest is unchanged; only handler code (or code it imports) changed.
 * - `environment`: only `.env` files changed; the application is not re-analyzed.
 * - `handlers`: handlers were added, removed, or changed their triggers or contracts; resources are unchanged.
 * - `resources`: resources or configuration entries were added, removed or changed.
 *
 * Every kind restarts the generation process, because Bun cannot unload
 * modules reliably. Local state (queued messages, stored objects, schedule
 * history) is never recreated: it lives in the state directory and survives
 * every kind of change, including removed resources, whose state is kept.
 */
export type ChangeKind = "initial" | "implementation" | "environment" | "handlers" | "resources";

/** Identities that were added, removed or changed. */
export interface IdentityChanges {
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly changed: readonly string[];
}

/** A classified change between two manifests. */
export interface ManifestChange {
  readonly kind: ChangeKind;
  /** Resources as `<kind> <id>`. */
  readonly resources: IdentityChanges;
  readonly handlers: IdentityChanges;
  /** Configuration entries by name. */
  readonly config: IdentityChanges;
  /**
   * Compatibility diagnostics of contracts that changed: queue messages,
   * request and response schemas. Reported, not enforced: during development
   * contracts change often, but messages already in a local queue were written
   * with the previous contract.
   */
  readonly contracts: readonly Diagnostic[];
}

/** No changes. */
const none: IdentityChanges = Object.freeze({ added: [], removed: [], changed: [] });

/**
 * Classifies the change from one manifest to the next.
 *
 * @param previous - The manifest of the running generation; `undefined` for the first build.
 * @param next - The new manifest.
 * @returns The classified change, with contract diagnostics.
 */
export function classifyChange(previous: Manifest | undefined, next: Manifest): ManifestChange {
  if (previous === undefined)
    return { kind: "initial", resources: { added: next.resources.map(resource => `${resource.kind} ${resource.id}`), removed: [], changed: [] }, handlers: { added: next.handlers.map(handler => handler.id), removed: [], changed: [] }, config: none, contracts: [] };
  const resources = compare(previous.resources, next.resources, resource => `${resource.kind} ${resource.id}`, resource => [resource.config, resource.requirements, fingerprints(resource.schemas)]);
  const config = compare(previous.config, next.config, entry => entry.name, entry => [entry.kind, entry.schema.fingerprint, entry.default ?? null]);
  const handlers = compare(previous.handlers, next.handlers, handler => handler.id, handler => [handler.trigger, fingerprints(handler.schemas)]);
  /**
   * Reports whether a list of changes is non-empty.
   *
   * @param changes - Added, removed and changed identities.
   * @returns `true` when anything changed.
   */
  const changed = (changes: IdentityChanges): boolean => changes.added.length + changes.removed.length + changes.changed.length > 0;
  const kind: ChangeKind = changed(resources) || changed(config) ? "resources" : changed(handlers) ? "handlers" : "implementation";
  return { kind, resources, handlers, config, contracts: contractDiagnostics(previous, next) };
}

/**
 * Compares two lists of identified entries.
 *
 * @param previous - The previous entries.
 * @param next - The next entries.
 * @param identity - The identity of an entry.
 * @param content - What must stay equal for an entry to count as unchanged.
 * @returns The added, removed and changed identities, sorted.
 */
function compare<Entry>(previous: readonly Entry[], next: readonly Entry[], identity: (entry: Entry) => string, content: (entry: Entry) => unknown): IdentityChanges {
  const before = new Map(previous.map(entry => [identity(entry), canonicalJsonStringify(content(entry) as never)]));
  const after = new Map(next.map(entry => [identity(entry), canonicalJsonStringify(content(entry) as never)]));
  return {
    added: [...after.keys()].filter(key => !before.has(key)).sort(),
    removed: [...before.keys()].filter(key => !after.has(key)).sort(),
    changed: [...after.keys()].filter(key => before.has(key) && before.get(key) !== after.get(key)).sort()
  };
}

/**
 * Reduces schema references to their fingerprints and versions, ignoring which library described them.
 *
 * @param schemas - Schema references by role.
 * @returns `{ role: "sha256:... vN" }`.
 */
function fingerprints(schemas: ManifestSchemaReferences): Record<string, string> {
  return Object.fromEntries(Object.entries(schemas).map(([role, reference]) => [role, `${reference.fingerprint} v${reference.schemaVersion ?? 1}`]));
}

/** One contract use: who declares it, its role and its schema references. */
interface ContractUse {
  readonly key: string;
  readonly subject: string;
  readonly role: ContractRole;
  readonly schemas: ManifestSchemaReferences;
  readonly schemaRole: string;
}

/**
 * Lists the contracts whose compatibility matters: queue messages, and the
 * request and response schemas of HTTP routes and procedures.
 *
 * @param manifest - A manifest.
 * @returns The contract uses, keyed by owner and role.
 */
function contractUses(manifest: Manifest): Map<string, ContractUse> {
  const uses = new Map<string, ContractUse>();
  for (const resource of manifest.resources) {
    if (resource.kind === "queue" && Object.hasOwn(resource.schemas, "message"))
      uses.set(`queue ${resource.id} message`, { key: `queue ${resource.id} message`, subject: `message for queue "${resource.id}"`, role: "message", schemas: resource.schemas, schemaRole: "message" });
  }
  for (const handler of manifest.handlers) {
    if (handler.trigger.kind !== "http.route" && handler.trigger.kind !== "http.procedure")
      continue;
    for (const schemaRole of Object.keys(handler.schemas)) {
      const role: ContractRole = schemaRole.startsWith("response.") || schemaRole === "output" ? "response" : "request";
      const key = `handler ${handler.id} ${schemaRole}`;
      uses.set(key, { key, subject: `${schemaRole} of handler "${handler.id}"`, role, schemas: handler.schemas, schemaRole });
    }
  }
  return uses;
}

/**
 * Runs the compatibility checker on every contract that changed.
 *
 * @param previous - The previous manifest.
 * @param next - The next manifest.
 * @returns The checker's diagnostics, in contract order.
 */
function contractDiagnostics(previous: Manifest, next: Manifest): Diagnostic[] {
  const before = contractUses(previous);
  const diagnostics: Diagnostic[] = [];
  for (const [key, use] of [...contractUses(next)].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) {
    const old = before.get(key);
    const oldRecord = old === undefined ? undefined : record(previous, old);
    const newRecord = record(next, use);
    if (oldRecord === undefined || newRecord === undefined || oldRecord.fingerprint === newRecord.fingerprint)
      continue;
    diagnostics.push(...checkSchemaCompatibility(oldRecord, newRecord, { role: use.role, subject: use.subject }).diagnostics);
  }
  return diagnostics;
}

/**
 * Builds the contract record of one schema use from a manifest's schema table.
 *
 * @param manifest - The manifest that holds the schema.
 * @param use - The contract use.
 * @returns The record, or `undefined` when the schema is missing.
 */
function record(manifest: Manifest, use: ContractUse): SchemaContractRecord | undefined {
  const reference = use.schemas[use.schemaRole];
  const schema = reference === undefined ? undefined : manifest.schemas[reference.fingerprint];
  if (reference === undefined || schema === undefined)
    return undefined;
  return { schemaVersion: reference.schemaVersion ?? 1, fingerprint: reference.fingerprint, contract: { ...schema, source: reference.source } };
}