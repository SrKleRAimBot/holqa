# 0022. Manifest version 1 and a separate entry point map

- **Status:** Proposed
- **Date:** 2026-10-18
- **Deciders:** Holqa maintainers
- **Refines:** [ADR 0014](0014-evaluation-based-manifest-extraction.md) decisions 3 and 4

> **Implementation status:** Implemented in `@holqa/compiler` (`compileApplication`, manifest version 1, `holqa.entrypoints/1`) and `@holqa/cli` (`holqa inspect`, `holqa build --manifest`). See the [compiler specification](../../reference/compiler-specification.md).

## Context

[ADR 0014](0014-evaluation-based-manifest-extraction.md) decided that the compiler obtains an application by evaluating `infra.ts` and its handler modules, and that the manifest is deterministic, with "root-relative POSIX module paths" and a schema table keyed by fingerprint. Implementing it raised questions that ADR 0014 left open:

- Handlers must keep their identity when files are moved or exports renamed. A manifest that records module paths and export names changes on such refactors, although the deployed application does not, so diffs and future deployment tooling would see changes that are not semantic.
- Executable artifacts need to know where each handler lives, and that information must stay explicitly tied to the manifest it belongs to.
- Schema fingerprints exclude the converter (`source`), so two uses with one fingerprint can come from different libraries. ADR 0014 requires the converter of every schema to be recorded.
- ADR 0014 accepted an allowlisted environment for the analysis process, but M0 did not prototype it, and the CLI receives the report from a process that ran untrusted code.
- The CLI may not depend on schema libraries or their adapters ([package boundaries](../package-boundaries.md)), yet the compiler needs adapters to describe schemas faithfully.

## Decision

1. **Identity-only manifest.** Manifest version 1 identifies resources and handlers by their declared `id` only. It records no module path, export name, variable name, alias or discovery pattern.
2. **Entry point map.** Module paths, export names and discovery patterns go into a separate document, `holqa.entrypoints/1`, which names the manifest it belongs to by `fingerprintManifest` (SHA-256 of the canonical manifest text). This replaces the module paths of ADR 0014 decision 4.
3. **Schema references carry their source.** A schema reference is `{ fingerprint, source, schemaVersion? }`; the schema table stores contracts without `source`. Equal fingerprints share one entry, keeping the smallest canonical text when descriptive text differs.
4. **Closed, versioned formats.** Both documents have published JSON Schemas with `additionalProperties: false`. Any new field or normalization change is a new version. `validateManifest` and `validateEntrypoints` are the readers.
5. **Analysis process.** The CLI evaluates modules in a Bun child process with an allowlisted environment (`PATH`, `HOME`, temporary directory variables, `TZ=UTC`, `LC_ALL=C`), `--no-env-file` (Bun would otherwise load `.env` files from the application root), `--no-install`, closed standard input, a timeout after which output is read for at most a short grace period, and an IPC channel for the report. The parent validates every diagnostic code, the manifest and the entry point map before using them. This implements ADR 0014 decision 3 and is documented as not being a sandbox.
6. **Adapters by convention.** The analysis process loads `@holqa/<vendor>` for each Standard Schema vendor, resolved from the application root, so the CLI never depends on an adapter package. Schemas of vendor `holqa` are described by a built-in adapter from their Standard JSON Schema.
7. **Explicit relationships only.** The resource graph records declared relationships (declares, registers, requires, triggers, schema). Runtime calls between handlers and resources are not inferred.

## Consequences

### Positive

- Renaming variables, aliases, files and exports leaves the manifest byte-identical, which the example tests verify.
- Build metadata can change without invalidating the manifest's fingerprint, and the map cannot be paired with the wrong manifest unnoticed.
- The CLI treats the analysis process as untrusted and never prints unvalidated data.
- Adapter packages stay optional and outside the CLI's dependency graph.

### Negative

- Consumers that need module locations must read two documents.
- A closed schema means every manifest addition is a version bump; readers must handle several versions once more exist.
- Adapter discovery by package name is a convention that a vendor name with unusual characters cannot use; such vendors fall back to Standard JSON Schema or fail.
- The analysis process still has the user's file-system and network access, and on some systems can read the CLI's environment through the operating system.
- `source.library` records the adapter's library version, so a schema library patch upgrade changes the manifest's bytes and fingerprint without a contract change (as ADR 0014 decision 5 accepts). The built-in `holqa` adapter records `holqa` without a version; its schemas change only with Holqa itself.

### Revisit when

- A practical sandbox for Bun processes exists (restricted file system and network).
- Applications need declared dependencies between handlers and resources, which would add `uses` edges.
- Bundling needs more metadata than the entry point map holds.

## Alternatives considered

### Module paths in the manifest (ADR 0014 as written)

Rejected: file moves and export renames would change the manifest, making refactors look like infrastructure changes.

### Keep `source` in the schema table

Rejected: the table is keyed by a fingerprint that excludes `source`, so one entry could not record two converters faithfully.

### Return descriptors to the parent process

Not possible: descriptors contain functions and schema objects. The analysis process compiles and returns JSON only.

### Make adapters CLI dependencies

Rejected: it violates the CLI's dependency direction and would pin every application to the CLI's adapter versions.

## Related

- [Compiler specification](../../reference/compiler-specification.md)
- [Compiler architecture](../compiler.md)
- [ADR 0007: Separate compiler and runtime](0007-separate-compiler-and-runtime.md)
- [ADR 0014: Evaluation-based manifest extraction](0014-evaluation-based-manifest-extraction.md)
- [ADR 0021: Schema contracts, wire payloads and compatibility](0021-schema-contracts-wire-payloads-and-compatibility.md)
