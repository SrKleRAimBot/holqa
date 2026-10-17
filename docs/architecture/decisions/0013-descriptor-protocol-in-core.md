# 0013. A descriptor protocol in `@holqa/core`

- **Status:** Accepted
- **Date:** 2026-10-17
- **Deciders:** Holqa maintainers

> **Implementation status:** Accepted design, validated by the disposable [`@holqa/experiment-model`](../../../experiments/model/) package. Nothing is implemented in `@holqa/core` yet.

## Context

The package boundaries ([package boundaries](../package-boundaries.md)) allow `@holqa/compiler` and `@holqa/runtime-bun` to depend on `@holqa/core` only, not on `@holqa/sdk`. Both must still understand everything the SDK produces: applications, resources, handlers, configuration entries, their schemas and their invocation functions. Without a shared contract, either the compiler and runtime would import the SDK (a dependency hub and a boundary violation), or each would reverse-engineer SDK objects.

M0 prototyped a descriptor protocol that the SDK writes and the compiler and runtime read. Both prototypes worked with no SDK dependency in `src/` (enforced by the boundary script).

## Decision

1. `@holqa/core` defines a versioned descriptor protocol. Every SDK value carries a descriptor under the string key `~holqa`, with `protocol: 1` and a `type` of `app`, `resource`, `handler` or `config`.
2. Descriptors hold JSON-only `config` and `trigger` data, Standard Schemas by role (for example `message`, `body`, `response.200`), and, for handlers, one `invoke(input, context)` function that validates untrusted input before running user code.
3. `@holqa/core` also defines the contracts that sit on that protocol: structural Standard Schema and Standard JSON Schema types (copied, not imported), `validateInput`, the `RuntimeBinding` interface with `bindApp` and `requireBinding`, and the `SchemaAdapter` interface.
4. Readers check descriptors structurally and ignore or reject unknown protocol versions, so duplicate package copies interoperate.
5. The SDK is the only package that creates descriptors for users. The compiler, runtime, testing utilities and integrations read them.

## Consequences

### Positive

- The compiler and runtime stay independent of the authoring API, and can be tested with hand-built descriptors.
- Other authoring front ends (for example an Effect-based API) can target the same protocol.
- Duplicate copies of `@holqa/core` in one installation do not break identity checks.

### Negative

- In M0 the application descriptor carries a mutable **binding slot** that `bindApp` writes. This deliberately mixes runtime binding state into the definition so that ambient handles imported from `infra.ts` can find their runtime, and it is why every runtime generation must evaluate its own `infra.ts` ([ADR 0015](0015-runtime-generations-and-reload.md)). Moving the state into a core-owned `WeakMap<AppDescriptor, RuntimeBinding>` keeps the descriptor immutable but does not remove the per-instance requirement; the choice is open ([backlog](../../milestones/m0/backlog.md) HB-07).
- The descriptor protocol becomes a public, versioned contract. Changing a field is a compatibility event for every reader.
- `@holqa/core` grows from primitives to a contract package, and needs careful review to stay infrastructure-neutral.

### Revisit when

- A second authoring front end needs fields the protocol cannot express.

## Alternatives considered

### Let the compiler and runtime depend on the SDK

Rejected. It makes the SDK a dependency hub, breaks the accepted layering, and couples execution to authoring ergonomics.

### `unique symbol` keys

Rejected. Two copies of the package produce two incompatible symbol types; a string key, like Standard Schema's `~standard`, avoids that.

### Classes with `instanceof` checks

Rejected for the same duplicate-copy reason, and because descriptors should stay JSON data plus the one `invoke` function per handler.

## Related

- [API design specification](../../reference/api-design.md#descriptor-protocol-holqacore)
- [ADR 0007: Separate compiler and runtime](0007-separate-compiler-and-runtime.md)
- [ADR 0017: Package layers after M0](0017-package-layers-after-m0.md)
