# Diagnostic codes

> **Status:** Ten codes are **Implemented** and registered in `diagnosticCodes` (`@holqa/core`). Other codes on this page are planned examples and are not emitted by any code.

Every problem Holqa reports is a structured `Diagnostic` with a stable code. Tools, CI scripts, and agents should match on the code, never on the message text, which may be reworded.

## Diagnostic shape

```ts
interface Diagnostic {
  readonly code: DiagnosticCode;
  readonly severity: "error" | "warning" | "info";
  readonly message: string;
  readonly location?: { readonly file: string; readonly line?: number; readonly column?: number };
  readonly hint?: string;
}
```

| Field | Meaning |
| --- | --- |
| `code` | A registered `HOLQA_*` code. |
| `severity` | `error` diagnostics fail the operation that produced them; `warning` and `info` do not. |
| `message` | A human-readable description. Not stable. |
| `location` | Optional source position; `line` and `column` are 1-based. |
| `hint` | Optional actionable guidance. |

Human-readable form (from `formatDiagnostic`; the location is shown for illustration, since `parseResourceId` itself does not attach one):

```text
infra.ts:12:7 error HOLQA_RESOURCE_ID_INVALID: Resource identifier "Orders" is invalid.
  hint: Use lowercase letters and digits, start with a letter, and separate segments with a single "-" or ".".
```

JSON form (as emitted by `holqa --json`):

```json
{"diagnostics":[{"code":"HOLQA_CLI_UNKNOWN_COMMAND","severity":"error","message":"Unknown command \"foo\".","hint":"Run \"holqa --help\" to list commands."}]}
```

## Implemented codes

| Code | Registry key | Emitted by | Meaning |
| --- | --- | --- | --- |
| `HOLQA_RESOURCE_ID_INVALID` | `resourceIdInvalid` | `parseResourceId` (`@holqa/core`) | A value is not a valid resource identifier: not a string, empty, longer than 63 characters, or not matching `^[a-z][a-z0-9]*(?:[-.][a-z0-9]+)*$`. |
| `HOLQA_CLI_UNKNOWN_COMMAND` | `cliUnknownCommand` | `runCli` (`@holqa/cli`) | The CLI received a command it does not recognize. Exit code `2`. |
| `HOLQA_CLI_NOT_IMPLEMENTED` | `cliNotImplemented` | `runCli` (`@holqa/cli`) | The command is a proposed command that has not been implemented yet. Exit code `1`. |
| `HOLQA_MANIFEST_NOT_SERIALIZABLE` | `manifestNotSerializable` | `canonicalJsonStringify` via `CanonicalJsonError` (`@holqa/compiler`) | A value cannot be represented in canonical JSON (for example `undefined`, a function, a `Date`, `NaN`, or a cycle). The message includes the JSON path. |
| `HOLQA_RESOURCE_ID_DUPLICATE` | `resourceIdDuplicate` | `checkIdentities` (`@holqa/core`), `defineApp` (`@holqa/sdk`) | Two resources in one application share an identifier. The message names every alias involved. |
| `HOLQA_DECLARATION_INVALID` | `declarationInvalid` | `@holqa/sdk` factories, registrations, `defineApp`, `composeResources` | A declaration is malformed: a missing or invalid option, a value that is not a Standard Schema, a non-resource in `resources`, a resource that already belongs to another application, an alias declared by two groups, or an operation on a handle never passed to `defineApp`. |
| `HOLQA_INPUT_INVALID` | `inputInvalid` | `validateInput` via `InputValidationError` (`@holqa/core`); queue `send` and handler `invoke` (`@holqa/sdk`) | Untrusted input failed schema validation at a trust boundary. The message lists issue paths and messages but never the rejected value. |
| `HOLQA_RUNTIME_NOT_BOUND` | `runtimeNotBound` | `requireBinding`, `resolveDriver`, `readConfig` (`@holqa/core`); handles and `app.env` (`@holqa/sdk`) | A resource handle or configuration value was used while no runtime binding is installed, for example at module top level. |
| `HOLQA_RUNTIME_ALREADY_BOUND` | `runtimeAlreadyBound` | `bindApp` (`@holqa/core`) | A binding was installed on an application instance that already has one. |
| `HOLQA_BINDING_CAPABILITY_UNSUPPORTED` | `bindingCapabilityUnsupported` | `bindApp`, `checkCapabilities`, `resolveDriver` (`@holqa/core`) | A binding does not support a declared resource kind, cannot satisfy a declared requirement, or has no driver for a kind with operations. One diagnostic per shortfall. |

All ten currently use severity `error`. Errors thrown by `@holqa/core` and `@holqa/sdk` are `HolqaError` instances whose `diagnostics` list every problem found.

## Stability policy

- Codes are part of Holqa's public, machine-readable contract.
- Once released, a code is **never renamed** and **never reused** for a different meaning.
- A code that is no longer emitted remains reserved and documented as retired.
- Message text and hints may change at any time; codes may not.
- New codes are added to `diagnosticCodes` in `packages/core/src/diagnostics/codes.ts` and documented on this page in the same change.
- The "versioned" aspect of codes means the registry evolves only by addition; consumers built against an older registry continue to work.

## Naming convention

Codes follow `HOLQA_<AREA>_<PROBLEM>`:

- All uppercase, words separated by underscores.
- `<AREA>` names the subsystem or concept: `RESOURCE`, `SCHEMA`, `MANIFEST`, `CLI`, `HANDLER`, `ROUTE`, `BINDING`, `CONFIG`.
- `<PROBLEM>` describes the condition, not the remedy: `INVALID`, `NOT_FOUND`, `DUPLICATE`, `UNSUPPORTED`, `NOT_IMPLEMENTED`.
- The registry key in `diagnosticCodes` is the camelCase equivalent (`HOLQA_RESOURCE_ID_INVALID` → `resourceIdInvalid`).

## Planned codes (not implemented)

The following are **examples of planned codes**. They are not in the registry and are not emitted by any code. Names may change before they are added; once added, they become stable.

| Planned code | Intended meaning | Expected emitter |
| --- | --- | --- |
| `HOLQA_RESOURCE_NOT_FOUND` | A handler or reference names a resource that is not declared. | Compiler (static validation) |
| `HOLQA_HANDLER_ID_DUPLICATE` | Two handlers share an identifier. | Compiler (handler discovery) |
| `HOLQA_SCHEMA_UNSUPPORTED` | A schema cannot be safely normalized into the portable representation. | Compiler (schema normalization), schema adapters |
| `HOLQA_ROUTE_AMBIGUOUS` | Two HTTP routes or procedures match the same request. | Compiler (static validation) |
| `HOLQA_QUEUE_CONSUMER_DUPLICATE` | More than one consumer is registered for a queue. | Compiler (static validation) |
| `HOLQA_CONFIG_INVALID` | A secret or variable fails validation at startup. | Runtime |

## Related

- [CLI reference](cli.md)
- [Compiler](../architecture/compiler.md#diagnostics)
- [Agent-native development](../concepts/agent-native-development.md)
