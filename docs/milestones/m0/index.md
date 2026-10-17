# M0: foundation and architecture validation

> **Status:** M0 deliverables recorded on 2026-10-17. ADRs 0012–0017 are Accepted as the M0 brief requires; like every accepted decision, they can be superseded by a later ADR.

M0 confirmed that the bootstrap scaffold provides the right foundations, and tested the riskiest parts of the proposed programming model with disposable prototypes before the SDK accumulates substantial code.

## Deliverables

| Deliverable | Where |
| --- | --- |
| Repository baseline report | [Baseline report](baseline-report.md) |
| Package dependency specification | [Package boundaries](../../architecture/package-boundaries.md), [ADR 0017](../../architecture/decisions/0017-package-layers-after-m0.md) |
| API design specification | [API design specification](../../reference/api-design.md) (Proposed) |
| Four technical proofs of concept | [`experiments/`](../../../experiments/README.md) and the [experiment results](experiment-results.md) |
| Accepted ADRs | [0012](../../architecture/decisions/0012-source-inferred-types-and-reply-helpers.md), [0013](../../architecture/decisions/0013-descriptor-protocol-in-core.md), [0014](../../architecture/decisions/0014-evaluation-based-manifest-extraction.md), [0015](../../architecture/decisions/0015-runtime-generations-and-reload.md), [0016](../../architecture/decisions/0016-schema-adapters-and-conversion-fidelity.md) (supersedes 0006), [0017](../../architecture/decisions/0017-package-layers-after-m0.md) |
| Initial product example | [`examples/commerce`](../../../examples/commerce/README.md) |
| Requirements backlog | [Backlog](backlog.md) (33 items with dependencies and acceptance criteria; not yet filed as GitHub issues) |

## Acceptance criteria

| Criterion | Result |
| --- | --- |
| The scaffold passes its intended checks | Yes. See the [baseline report](baseline-report.md). |
| Package boundaries approved | Yes. [ADR 0017](../../architecture/decisions/0017-package-layers-after-m0.md) was approved as written by the repository owner on 2026-10-17. The existing directions were confirmed by prototypes; no existing package needed a new dependency. |
| Each experiment has a documented result | Yes. See the [experiment results](experiment-results.md). |
| Fundamental limitations discovered before the SDK grows | Ten are recorded in [limitations of the programming model](experiment-results.md#limitations-of-the-programming-model). The most consequential are literal widening in handler returns, evaluation-based compilation, lazy access to bindings, and cooperative cancellation. |

## Validation

After all M0 changes, the full gate was run with the Turborepo cache bypassed:

```sh
pnpm turbo run build typecheck typecheck:repo lint lint:repo test agents:check boundaries:check --force
```

Result: 42 of 42 tasks successful, 0 cached, 6.3 s (final run after review fixes); 10 workspace packages passed the boundary check. Test counts:

| Package | Tests |
| --- | --- |
| `@holqa/core` | 27 |
| `@holqa/compiler` | 16 |
| `@holqa/cli` | 9 |
| `@holqa/example-package-smoke` | 6 (unchanged, so no public API broke) |
| `@holqa/experiment-model` | 11 |
| `@holqa/experiment-sdk` | 24, plus the type-level corpus checked by `tsc` |
| `@holqa/experiment-schema-adapters` | 48 |
| `@holqa/experiment-compiler` | 38 |
| `@holqa/experiment-runtime-bun` | 45 |
| `@holqa/example-commerce` | 8 |

CI ran the same gate on [pull request #2](https://github.com/SrKleRAimBot/holqa/pull/2) ([run 39039140660](https://github.com/SrKleRAimBot/holqa/actions/runs/39039140660)) on `ubuntu-latest`, with `pnpm install --frozen-lockfile` followed by `pnpm check`. The "Quality gates" job passed in 1 min 9 s: 42 of 42 tasks, 0 cached, with the same per-package test counts and 0 failures. CI covers the `package-smoke` export checks (built `dist/` output, no unresolved aliases, the `holqa` bin). publint and Are the Types Wrong still run only locally ([backlog](backlog.md) HB-01).

Environment for the local run: Node.js 22.23.3 (the earlier 22.20.0 installation disappeared during M0), Bun 1.3.13, pnpm 12.14.0, TypeScript 6.0.3.

## Compatibility impact

No public contract of an implemented package changed: `@holqa/core`, `@holqa/compiler` and `@holqa/cli` exports, diagnostic codes, CLI output and canonical JSON are untouched, and `examples/package-smoke` passes unchanged. No changeset is needed. Repository tooling changed (workspace globs, the catalog, the boundary script, ESLint file globs, `lint:repo` ignores); see the [baseline report](baseline-report.md#changes-made-in-m0).

## Related

- [Roadmap](../../roadmap.md)
- [Status model](../../architecture/status-model.md)
