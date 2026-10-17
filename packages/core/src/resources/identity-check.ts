import type { Diagnostic } from "@/diagnostics/diagnostic";

import { diagnosticCodes } from "@/diagnostics/codes";
import { createDiagnostic } from "@/diagnostics/diagnostic";
import { parseResourceId } from "@/identity/resource-id";

/** One declared identity to check, with a label that tells the reader where it was declared. */
export interface DeclaredIdentity {
  /** The declared identifier, unvalidated. */
  readonly id: unknown;
  /** Where the identity was declared, for example `resources.orders`. */
  readonly label: string;
}

/**
 * Checks a set of resource identities that must be unique within one
 * application. Reports every invalid and
 * every duplicated identifier at once, in declaration order, so that one run
 * surfaces all problems.
 *
 * @param identities - The declared identities, in declaration order.
 * @param scope - What the identities name, for messages (for example `resource`). Duplicates are always reported
 * as `HOLQA_RESOURCE_ID_DUPLICATE`; handler identities will get their own code when the compiler checks them.
 * @returns `HOLQA_RESOURCE_ID_INVALID` and `HOLQA_RESOURCE_ID_DUPLICATE` diagnostics; empty when all identities are valid and unique.
 */
export function checkIdentities(identities: readonly DeclaredIdentity[], scope: string): readonly Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const labelsById = new Map<string, string[]>();
  for (const identity of identities) {
    const parsed = parseResourceId(identity.id);
    if (!parsed.ok) {
      diagnostics.push(createDiagnostic({ ...parsed.error, message: `${identity.label}: ${parsed.error.message}` }));
      continue;
    }
    labelsById.set(parsed.value, [...labelsById.get(parsed.value) ?? [], identity.label]);
  }
  for (const [id, labels] of labelsById) {
    if (labels.length < 2)
      continue;
    diagnostics.push(createDiagnostic({
      code: diagnosticCodes.resourceIdDuplicate,
      severity: "error",
      message: `The ${scope} identifier "${id}" is declared more than once: ${labels.join(", ")}.`,
      hint: "Identifiers are persistent identities and must be unique within an application. Give each declaration its own id."
    }));
  }
  return diagnostics;
}