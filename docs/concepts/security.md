# Security

> **Status:** Accepted design, with **Implemented** parts: runtime validation at trust boundaries (`validateInput`), secret handling in manifests, and the analysis process used by `holqa inspect` and `holqa build --manifest` ([untrusted build-time execution](#untrusted-build-time-execution)). These are the security principles that Holqa's SDK, compiler, runtime, providers, and tooling must follow. To report a vulnerability, see [`SECURITY.md`](../../SECURITY.md).

Holqa sits between application code and infrastructure, so its design choices affect what data is trusted, who can change infrastructure, and where secrets can leak. This page records the principles that apply across all packages.

## Trust boundaries

A trust boundary is any point where data enters from a source the application does not control. Holqa treats the following as trust boundaries:

| Boundary | Untrusted input | Required control |
| --- | --- | --- |
| HTTP and RPC requests | Path, query, headers, body | Validate against declared schemas before the handler runs. |
| Queue messages | Message payloads, including those produced by older deployments | Validate on consumption; reject or dead-letter invalid messages. |
| Storage events | Event metadata and object contents | Validate metadata; treat object contents as untrusted. |
| Configuration | Environment variables and secret values | Validate at startup; fail fast on missing or malformed values. |
| External events (future) | Webhooks and third-party streams | Validate payloads and authenticate senders. |
| Build-time inputs | User configuration code, dependencies | See [untrusted build-time execution](#untrusted-build-time-execution). |

Static types do not validate any of these. Runtime validation is mandatory ([type safety and schemas](type-safety-and-schemas.md#runtime-validation-at-trust-boundaries)).

Implemented example of the pattern: `parseResourceId` in `@holqa/core` accepts `unknown`, never throws, and returns a `Result` with a `HOLQA_RESOURCE_ID_INVALID` diagnostic for invalid input.

## Secret handling

Secrets are declared explicitly (illustrative: `secret(z.string().min(1))`) and kept separate from non-sensitive variables. Rules:

- **No secrets in source.** Credentials are never hardcoded in application code, examples, tests, or this repository.
- **No secrets in manifests.** The manifest records that a secret named `DATABASE_URL` is required and its schema, never its value.
- **No secrets in generated clients.** Browser-safe clients contain only public contract information.
- **No secrets in diagnostics, logs, or tool output.** Validation errors for a secret report that it is invalid, not what it contains. Agent-facing output follows the same rule ([agent-native development](agent-native-development.md#safety)).
- **Secrets are bound per environment** by the binding layer, not by the application definition.

## Safe infrastructure changes

| Principle | Detail |
| --- | --- |
| Deleting a declaration is not authorization to destroy. | Removing a resource from `infra.ts` stops the application using it. Destroying the physical resource is a separate, explicit action ([application model](application-model.md#resource-lifecycles)). |
| Identity changes are visible. | Changing a resource `id` is surfaced as replacement, not hidden as a rename ([ADR 0004](../architecture/decisions/0004-stable-logical-resource-identities.md)). |
| Plan before apply. | Provisioning providers produce a reviewable plan. |
| Destructive changes require explicit confirmation. | Never performed silently by a tool or an agent. |
| Runtime and provisioning credentials are separate. | Runtime drivers do not receive provisioning permissions ([infrastructure providers](infrastructure-providers.md)). |
| Least privilege. | Runtime permissions can be derived from the resource graph's `uses` edges ([resource graph](resource-graph.md#dependencies-and-least-privilege)). |
| Unsupported semantics fail. | A binding that cannot satisfy a requirement is rejected rather than silently weakened. |

## Schema validation

- Schemas are the single source for both types and runtime checks, so they cannot drift.
- Validation happens before handler code sees data.
- Schemas that cannot be normalized produce an explicit diagnostic (`HOLQA_SCHEMA_UNSUPPORTED`, **Implemented**) instead of being approximated, because an approximated schema might accept data the developer intended to reject.
- Messages from older deployments are untrusted with respect to the current schema; message codecs reject unaccepted schema versions and the compatibility checker flags breaking changes (**Implemented** as library functions; running them against a deployment is planned) ([compatibility and evolution](type-safety-and-schemas.md#compatibility-and-evolution)).

## Untrusted build-time execution

The compiler must understand `infra.ts` and handler modules. If it does so by importing and evaluating them, it executes arbitrary user code (and that code's dependencies) at build time.

Holqa's position:

- **The compiler must not execute user configuration code unsandboxed while claiming that evaluation is secure.** If declarations are evaluated, documentation and tooling must state that building an application runs its code with the privileges of the build process, exactly like running its tests.
- Declarations are designed to be pure and deterministic ([ADR 0003](../architecture/decisions/0003-explicit-resource-declarations.md)) so that evaluation *can* be constrained. Static analysis is limited to a partial index for editors and agents ([ADR 0014](../architecture/decisions/0014-evaluation-based-manifest-extraction.md)).
- **Implemented** ([ADR 0014](../architecture/decisions/0014-evaluation-based-manifest-extraction.md), [ADR 0022](../architecture/decisions/0022-manifest-v1-and-entry-point-map.md)): `holqa inspect` and `holqa build --manifest` evaluate `infra.ts` and the handler modules, so compiling an application runs its code. The CLI does this in a separate Bun process that receives only an allowlisted environment (`PATH`, `HOME`, temporary directory variables, `TZ=UTC`, `LC_ALL=C`; never the application's secrets or deployment credentials), runs with `--no-env-file` and `--no-install`, has standard input closed, is killed after 60 seconds, and returns its report over IPC. The CLI validates the report (diagnostic codes, manifest, entry point map) before using it.
- That process runs as the same user: it can still read and write files (including `.env` and credential files), on some systems read other processes' environments, and use the network. **It reduces exposure; it is not a sandbox.** See the [security model](../reference/compiler-specification.md#security-model).
- Secret values never reach the manifest: the compiler records a secret's name and schema only, never reads configuration values, and rejects a secret that declares a default.
- Building an untrusted repository is equivalent to running untrusted code unless and until a real sandbox is implemented and documented.

The implemented canonical JSON serializer contributes a narrow guarantee: it rejects functions, symbols, class instances, `undefined`, non-finite numbers, and cycles, so executable values cannot be smuggled into a manifest as data.

## Browser-safe clients

Generated clients run in browsers, which are fully untrusted environments:

- They must not expose private handlers, internal functions, private resources, credentials, or secrets.
- They contain public contract types, the schemas needed for client-side validation, and Fetch-based transport code only.
- Client-side validation improves user experience but never replaces server-side validation.
- `@holqa/client` and `@holqa/sdk` are prohibited from importing compiler, runtime, Bun, or Node modules by ESLint and the boundary check ([package boundaries](../architecture/package-boundaries.md)), which reduces the risk of server code being bundled into clients.

## Authentication

Holqa does not provide or require its own identity service. Authentication is expected to be implemented with general-purpose typed middleware and optional integrations ([triggers and execution](triggers-and-execution.md#middleware)).

## Related

- [`SECURITY.md`](../../SECURITY.md): vulnerability reporting.
- [Infrastructure providers](infrastructure-providers.md)
- [Compiler](../architecture/compiler.md)
- [Agent-native development](agent-native-development.md)
