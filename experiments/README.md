# M0 experiments

> **Status:** Disposable M0 experiments — not part of the framework. Nothing here is published, exported from `packages/`, or covered by compatibility guarantees.

These workspace packages answer the M0 architecture questions with running code before `@holqa/sdk` and the real compiler and runtime accumulate substantial code. Results are summarized in [M0 experiment results](../docs/milestones/m0/experiment-results.md).

| Package | Question | Stands in for | Results |
| --- | --- | --- | --- |
| [`model`](model/) (`@holqa/experiment-model`) | Which contracts must the compiler and runtime share without depending on the SDK? | Future `@holqa/core` additions | Used by all experiments |
| [`sdk`](sdk/) (`@holqa/experiment-sdk`) | Do exact schema types flow through `defineApp`, handles and separate handler modules? | `@holqa/sdk` | [README](sdk/README.md) |
| [`compiler`](compiler/) (`@holqa/experiment-compiler`) | Can declarations become a deterministic, portable manifest? | `@holqa/compiler` pipeline | [README](compiler/README.md) |
| [`runtime-bun`](runtime-bun/) (`@holqa/experiment-runtime-bun`) | Can handlers be registered, invoked concurrently, cancelled, disposed and reloaded safely? | `@holqa/runtime-bun` | [README](runtime-bun/README.md) |
| [`schema-adapters`](schema-adapters/) (`@holqa/experiment-schema-adapters`) | Can Zod (and Valibot) schemas be validated and normalized without coupling core to them? | `packages/integrations/zod`, `valibot` | [README](schema-adapters/README.md) |

## Rules

- Experiments follow the repository's code style, lint, test and boundary rules. `scripts/check-boundaries.ts` checks them against an `experimentDependencies` table that mirrors the target layering: the compiler and runtime prototypes may not depend on the SDK prototype in `src/`.
- Framework packages under `packages/` must never depend on an experiment.
- [`examples/commerce`](../examples/commerce/README.md) depends on the experiments until the real SDK exists. Migrating it is a backlog item.
- Experiments are deleted, not evolved, once the corresponding framework package is implemented. The real packages are written from the [API design specification](../docs/reference/api-design.md) and the accepted ADRs.

## Running

```sh
pnpm turbo run build typecheck lint test --filter="./experiments/*"
```
