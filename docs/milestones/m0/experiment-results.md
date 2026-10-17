# M0 experiment results

> **Status:** Results recorded on 2026-10-17 from four disposable prototypes under [`experiments/`](../../../experiments/README.md) ran and recorded these results None of them is a framework capability.

Each experiment has a detailed README with its method, numbers and caveats. This page summarizes the answers and, most importantly, the limitations M0 found in the proposed programming model.

## Answers

| Question | Answer | Evidence | Decision |
| --- | --- | --- | --- |
| **Type inference.** Can `infra.ts` preserve exact schema types through `defineApp`, handles and separate handler modules without generated types? | **Yes.** Literal identifiers, input and output sides, imported and composed schemas, brands, transforms and defaults all flow into separate handler modules, through source and through built `.d.ts` files. Type-checking cost is linear (1.05 s for 200 queues, 200 routes and 200 consumers). | [`experiments/sdk`](../../../experiments/sdk/README.md): 24 tests plus a type-level corpus enforced by `tsc` | [ADR 0012](../../architecture/decisions/0012-source-inferred-types-and-reply-helpers.md) |
| **Deterministic compilation.** Can definitions and handler metadata become a stable, portable manifest, including imported schemas? | **Yes, by evaluating the modules.** Manifests are byte-identical across five processes, two absolute paths and shuffled discovery orders. Imported schemas are fully represented, and secrets never appear. | [`experiments/compiler`](../../../experiments/compiler/README.md): 38 tests | [ADR 0014](../../architecture/decisions/0014-evaluation-based-manifest-extraction.md) |
| **Bun runtime lifecycle.** Can handlers be registered, invoked concurrently, cancelled, disposed and reloaded without corrupting state? | **Yes, with defences.** All invariants held under stress for both strategies: settlement exactly once, limits never exceeded, no work in disposed generations, isolated module state. | [`experiments/runtime-bun`](../../../experiments/runtime-bun/README.md): 45 tests | [ADR 0015](../../architecture/decisions/0015-runtime-generations-and-reload.md) |
| **Schema interoperability.** Can Zod schemas be validated and normalized without tying core to Zod? | **Yes for validation and inference; normalization needs library-specific adapters.** The model and SDK contain no Zod or Valibot reference. Generic conversion silently drops constraints, so only adapters can keep the "never silently approximated" rule. | [`experiments/schema-adapters`](../../../experiments/schema-adapters/README.md): 48 tests | [ADR 0016](../../architecture/decisions/0016-schema-adapters-and-conversion-fidelity.md) |
| **Package boundaries.** Do the planned dependency directions hold? | **Yes.** The compiler and runtime worked without the SDK, through a descriptor protocol in the contracts layer. | Boundary script over the experiments | [ADR 0013](../../architecture/decisions/0013-descriptor-protocol-in-core.md), [ADR 0017](../../architecture/decisions/0017-package-layers-after-m0.md) |

The [commerce example](../../../examples/commerce/README.md) ties the four together: it type-checks against the built prototype SDK, compiles with no errors (one honest warning: a transform's output side has no JSON Schema), and runs end to end on the prototype runtime (8 tests).

## Limitations of the programming model

These are properties of TypeScript, JavaScript, Bun or the schema libraries. They cannot be fixed in Holqa's code, so they shape the design.

| # | Limitation | Consequence for the design |
| --- | --- | --- |
| 1 | **TypeScript widens literals in returned object literals** when their expected type depends on a type parameter of the same call. `({ status: 200, body })` fails against declared responses. | Handlers build responses with `context.reply(status, body)` (or `as const`). Applies to future RPC outputs too. |
| 2 | **Compiling runs user code.** Static analysis cannot recover imported or composed schemas. | Evaluation-based extraction with a documented trust model and a secret-free analysis environment. |
| 3 | **Module top-level side effects break analysis.** Reading `config.X` or using a handle at import time fails, by design, with `HOLQA_RUNTIME_NOT_BOUND`. | Lazy access is a programming-model rule. The illustrative `basic-backend` and Drizzle docs were updated. |
| 4 | **Generic JSON Schema conversion is lossy and silent.** Zod drops refinements, `trim` and case transforms even with `unrepresentable: "throw"`. | Library-specific adapters (which read unstable internals) mark fidelity; the generic path is always "unverified". |
| 5 | **Fingerprints depend on the library and its version.** The same contract produces different JSON Schema in Zod and Valibot. | Fingerprints are a change signal, not a compatibility verdict. The manifest records the converter. |
| 6 | **Producers and consumers see different types.** Defaults, transforms and Zod's output-side `additionalProperties: false` differ by side. | The manifest records both sides. The wire carries the input form, and consumers decode. (M0 found and fixed an SDK bug that sent the decoded form.) |
| 7 | **No in-process hard cancellation.** A handler that ignores `signal` keeps running. | Orphans are tracked and keep their concurrency slots. Honouring `signal` is part of the handler contract. Only Workers can hard-stop. |
| 8 | **Bun's module cache is not a reload API.** Query busting misses transitive modules, ESM eviction is undocumented, and a parse failure makes later imports hang forever. | One Worker per generation for `holqa dev`, a parse pre-check, and import timeouts. Re-validate on every Bun upgrade. |
| 9 | **Ambient handles need one application instance per generation.** | Each generation evaluates its own `infra.ts`; resource drivers live in the runtime. Per-invocation context for ambient calls is an open item. |
| 10 | **`isolatedDeclarations` is incompatible with inferred handler exports.** | Documented as unsupported for application modules. |

None of these invalidates the programming model. Limitations 1, 3 and 7 change what application code looks like, and are reflected in the [API design specification](../../reference/api-design.md#programming-model-rules-found-in-m0).

## Related

- [M0 summary](index.md)
- [Backlog](backlog.md)
