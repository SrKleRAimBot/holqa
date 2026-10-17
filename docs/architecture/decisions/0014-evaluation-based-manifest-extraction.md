# 0014. Evaluation-based manifest extraction

- **Status:** Accepted
- **Date:** 2026-10-17
- **Deciders:** Holqa maintainers
- **Resolves:** the open question in [ADR 0007](0007-separate-compiler-and-runtime.md) decision 7 (how `infra.ts` is analyzed)

> **Implementation status:** Accepted design, validated by the disposable [compilation experiment](../../../experiments/compiler/README.md). The manifest schema and compiler pipeline are not implemented in `@holqa/compiler`.

## Context

The [compiler](../compiler.md) document left open whether `infra.ts` is read by static analysis, by evaluating it, or both. The constraint was that Holqa must not run user code unsandboxed while claiming that this is secure.

M0 built a manifest by evaluating `infra.ts` and the handler modules in a Bun host, then passing the descriptors to a runtime-neutral compiler. The results:

- Manifests were byte-identical across five separate processes, two different absolute paths and shuffled discovery orders.
- Schemas imported through several modules were fully represented.
- Secrets in the compiling process never appeared in the manifest.
- Compilation took about 18 ms of module evaluation plus 0.9 ms for compilation and serialization for a 6-handler application.

It also showed that static analysis cannot produce schemas, because only the schema library's own converter, run on the evaluated value, yields JSON Schema and knows what a refinement does.

## Decision

1. The compiler obtains the application by **evaluating** `infra.ts` and the modules matched by its `handlers` globs. A host (the CLI) does the evaluation in a dedicated process. `@holqa/compiler` receives `{ app, modules }` and stays runtime-neutral.
2. Documentation states plainly that `holqa build`, `holqa inspect` and every command that compiles an application **execute the application's modules**, like running its tests. Evaluation is not described as sandboxed or safe for untrusted repositories.
3. The analysis process gets an **allowlisted** environment: only variables the host explicitly passes, never the application's secrets. This is not a sandbox, and M0 did not prototype it (the experiment passed the full environment and showed only that secret values never reach the manifest). Using a runtime binding or configuration value during module evaluation fails with `HOLQA_MODULE_EVALUATION_FAILED`, citing `HOLQA_RUNTIME_NOT_BOUND`. The compiler never invents configuration values.
4. The manifest is deterministic: entries sorted by identifier, root-relative POSIX module paths, canonical JSON, and a `manifestVersion`. Schemas are stored in a table keyed by `sha256:` fingerprints of a normalized form. Normalization rules are versioned with the manifest.
5. Fingerprints are a change signal, not a compatibility verdict. The manifest records the converter (library and version) of every schema.
6. Static analysis is allowed only as a fast, partial index (identifiers, route paths) for editors and agents, never as the source of the manifest.

## Consequences

### Positive

- Full support for imported, composed and computed schemas.
- One code path for the compiler, the runtime and the tests: all evaluate the same modules.

### Negative

- Compiling a repository runs its code; the trust assumption must be documented before the compiler ships.
- Module top-level side effects break compilation, which constrains the programming model: binding and configuration access must be lazy.
- Fingerprints change when a schema library changes its JSON Schema output, even if the contract did not change.

### Revisit when

- A practical sandbox for module evaluation exists for Bun (restricted process, no network, read-only file system), and could be added as hardening.

## Alternatives considered

### Static analysis of TypeScript source

Rejected as the primary strategy. It cannot evaluate schema libraries, imported values, `.extend()` chains or conditionals, so it cannot produce schemas, fingerprints or runtime-only notes.

### Type-checker-based extraction

Not prototyped. TypeScript types do not carry runtime constraints (lengths, patterns, refinements), so they cannot produce faithful JSON Schema either.

## Related

- [Compilation experiment](../../../experiments/compiler/README.md)
- [Security](../../concepts/security.md#untrusted-build-time-execution)
- [ADR 0007: Separate compiler and runtime](0007-separate-compiler-and-runtime.md)
