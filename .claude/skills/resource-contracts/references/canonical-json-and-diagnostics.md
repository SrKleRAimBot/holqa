# Canonical JSON and diagnostics reference

Source of truth: `packages/compiler/src/manifest/canonical-json.ts` and `packages/core/src/diagnostics/`. If this file disagrees with the code, the code wins; fix this file.

## `canonicalJsonStringify(value: unknown): string`

| Input | Output |
| --- | --- |
| `null`, booleans, strings | As `JSON.stringify` |
| Finite numbers | As `JSON.stringify`; `-0` → `0` |
| Arrays | Order preserved; each item canonicalized |
| Plain objects (prototype `Object.prototype` or `null`) | Keys sorted with default `Array.prototype.sort` (UTF-16 code units) |
| Formatting | 2-space indent, `\n`, no trailing newline; `{}` and `[]` for empty containers |

Rejected (throws `CanonicalJsonError`):

| Value | Example path in message |
| --- | --- |
| `undefined` property or array item | `$.value`, `$[1]` |
| Function | `$.handler` |
| Symbol | `$.tag` |
| `bigint` | `$.size` |
| `NaN`, `Infinity`, `-Infinity` | `$.ratio` |
| `Date`, `Map`, `Set`, class instances | `$.at` |
| Circular reference | path where the cycle closes |

Paths use `$` for the root, `.key` for properties, and `[index]` for array items. Keys are not quoted or escaped in paths.

### Handling the error

```ts
import {
  CanonicalJsonError,
  canonicalJsonStringify
} from "@holqa/compiler";

try {
  return canonicalJsonStringify(manifestDraft);
} catch (error) {
  if (error instanceof CanonicalJsonError)
    return reportDiagnostics([error.diagnostic]);   // code HOLQA_MANIFEST_NOT_SERIALIZABLE
  throw error;
}
```

(`reportDiagnostics` is a placeholder for the caller's own reporting.)

### Golden tests

Generate expected output with the function once, review it, and store it inline or under `tests/fixtures/`. Re-generating goldens to make a failing test pass hides real output changes: explain any golden update in the change summary.

## Diagnostics

```ts
interface Diagnostic {
  readonly code: DiagnosticCode;          // from diagnosticCodes
  readonly severity: "error" | "warning" | "info";
  readonly message: string;
  readonly location?: { readonly file: string; readonly line?: number; readonly column?: number };
  readonly hint?: string;
}
```

- `createDiagnostic` freezes the result and omits absent optional fields (no `undefined` values), so diagnostics serialize stably.
- `formatDiagnostic` renders `file:line:col severity CODE: message`, then `\n  hint: ...` when a hint exists. Lines and columns are 1-based.
- The CLI's `--json` mode writes `{"diagnostics":[...]}` to stderr. Agents and tests should parse that shape and match on `code`.

### Code naming

- Value: `HOLQA_<AREA>_<PROBLEM>`, uppercase with underscores (`HOLQA_RESOURCE_ID_INVALID`).
- Key: camelCase of area and problem (`resourceIdInvalid`).
- Area examples in use: `RESOURCE`, `CLI`, `MANIFEST`. Codes the architecture docs mention for the future (for example `HOLQA_RESOURCE_NOT_FOUND`, `HOLQA_SCHEMA_UNSUPPORTED`) do **not** exist until added to the registry.
