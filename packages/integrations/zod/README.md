# Zod integration (planned)

> **Status:** Planned. No code exists yet.

Zod is the first-class initial schema library. This adapter will map Zod schemas onto Holqa's normalized schema
representation (input/output types, JSON Schema metadata, fingerprints) and report `HOLQA_SCHEMA_UNSUPPORTED`-style
diagnostics for transformations that cannot be represented faithfully. See
[ADR 0006](../../../docs/architecture/decisions/0006-standard-schema-and-portable-schema-representation.md).
