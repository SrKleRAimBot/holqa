# 0007. Separate compiler and runtime

- **Status:** Accepted (foundational principle, not implemented)
- **Date:** 2026-10-17
- **Deciders:** Holqa maintainers

> **Implementation status:** The package boundary exists. The compiler and runtime do not. `@holqa/compiler` currently contains only `canonicalJsonStringify`, the deterministic JSON serializer that will underpin the manifest. There is no manifest schema, resource analysis, handler discovery or client generation. `@holqa/runtime-bun` is planned (a README only).

## Context

Holqa has to turn an application's declarations and handlers into several outputs:

1. A deterministic, versioned, infrastructure-neutral **application manifest** describing logical resources and deployment requirements.
2. **Executable artifacts** for the target runtime.
3. **Generated clients and API contracts** that are safe to import in browsers.
4. **Structured diagnostics**: duplicate identifiers, invalid references, incompatible requirements, ambiguous routes, invalid schemas.

At run time, Holqa also has to execute handlers, validate messages and talk to runtime drivers. If analysis and execution are combined, deployed applications carry compiler code and dependencies, compile-time decisions are made again (and possibly differently) at run time, and nothing produces an inspectable artifact describing the application.

Analysis also involves untrusted input. Loading `infra.ts` means evaluating user code, which must not be presented as safe unless it is sandboxed.

## Decision

1. **The compiler and the runtime are separate packages with separate responsibilities.** `@holqa/compiler` analyses and produces artifacts. Runtime packages (planned `@holqa/runtime-bun`, `@holqa/local`) execute them.
2. **The manifest is the contract between them.** The runtime consumes compiler output and does not re-analyse source. The manifest describes logical requirements, not provider-specific resources.
3. **Compiler output is deterministic.** The same input gives byte-identical manifests. Today `canonicalJsonStringify` guarantees deterministic JSON: sorted keys at every depth, 2-space indentation, no trailing newline, and `-0` normalized to `0`. It rejects values that cannot be represented, such as `undefined`, functions, symbols, `bigint`, non-finite numbers, non-plain objects and cycles, by throwing `CanonicalJsonError` with diagnostic `HOLQA_MANIFEST_NOT_SERIALIZABLE` and a JSON path.
4. **Compilation and bundling are separate concerns.** Analysis and manifest generation do not depend on how executable artifacts are bundled.
5. **Diagnostics are structured and versioned** (`HOLQA_*` codes from `@holqa/core`), suitable for humans and agents.
6. **Dependency direction:** the compiler depends on `@holqa/core` only. Public SDK and client packages must never import the compiler, and runtime packages do not depend on it. `scripts/check-boundaries.ts` and ESLint enforce this today.
7. **User configuration code is not evaluated unsandboxed while being described as secure.** How the compiler loads `infra.ts` (static analysis, sandboxed evaluation, or explicitly trusted evaluation) is an open design question.

Points 1, 3 (the serializer), 5 and 6 are reflected in the repository today. The rest is accepted design.

## Consequences

### Positive

- Deployed applications do not ship compiler code.
- The manifest is an inspectable, diffable artifact for reviews, agents and provider tooling.
- Deterministic output enables caching, reproducible builds and meaningful diffs.
- The SDK stays light and browser-safe because it cannot pull in compiler internals.

### Negative

- Two code paths have to agree on the manifest format, which means a versioned schema and compatibility tests (planned).
- Some checks that could be done lazily at run time have to be done ahead of time.
- Sandboxing or statically analysing user configuration is a hard, unresolved problem.

## Alternatives considered

### Runtime-only framework (analyse on startup)

Rejected. There would be no deployable artifact to inspect, analysis cost at every cold start, and no way to validate before deployment.

### Single package containing compiler and runtime

Rejected. Runtime bundles would carry compiler dependencies, and the boundary that keeps the SDK browser-safe would erode.

### Code generation as the primary source of application types

Rejected for application-internal types. Source-based inference is preferred ([type safety and schemas](../../concepts/type-safety-and-schemas.md)). Code generation remains the plan for external consumers, such as browser clients and OpenAPI.

## Related

- [Compiler architecture](../compiler.md)
- [Package boundaries](../package-boundaries.md)
- [Diagnostic codes](../../reference/diagnostic-codes.md)
- [`packages/compiler/src/manifest/canonical-json.ts`](../../../packages/compiler/src/manifest/canonical-json.ts)
- [ADR 0005: Infrastructure-independent resource contracts](0005-infrastructure-independent-resource-contracts.md)
- [ADR 0006: Standard Schema](0006-standard-schema-and-portable-schema-representation.md)
