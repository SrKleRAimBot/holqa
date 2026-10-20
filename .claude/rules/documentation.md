# Documentation

- Update documentation in the same change whenever a public API, diagnostic code, CLI behavior, package boundary, or architectural contract changes. Relevant places: `docs/reference/`, `docs/architecture/`, package READMEs, `docs/roadmap.md`, and `docs/architecture/status-model.md`.
- Never describe an unimplemented capability as working. Label status with exactly one of: **Implemented**, **Accepted design**, **Proposed**, **Planned** (defined in [status-model.md](../../docs/architecture/status-model.md)). When unsure, choose the weaker status.
- Only the items listed as Implemented in the status model exist today. Providers and bindings for external infrastructure (only the runtime's default environment binding and the local binding in `@holqa/local` exist), worker isolation, module-level hot-swapping (reload is a process restart), topics, client generation, bundling (`holqa build` without `--manifest`), `holqa openapi generate`, and `@holqa/testing` beyond `createTestApp` and type assertions are not implemented. The implemented CLI commands are `inspect` (with `--cycles`), `build --manifest`, `dev`, `invoke`, `queue send`, `queue redrive`, `storage put`, `cron run`, `state` and `doctor`. Event safety (cycle analysis, lineage, runtime limits, idempotency) is implemented; queue backlog thresholds and per-operation budgets on bindings other than `@holqa/local` are not.
- Introduce code that uses unimplemented APIs with: "The following code is illustrative. The API is proposed, not implemented, and may change."
- Never show command output or test results that were not produced by actually running the command.
- Present Holqa as an independent, infrastructure-agnostic framework. Do not name or imply a proprietary or first-party hosting product, and do not center a single cloud vendor.
- Every concept and architecture document starts with one `#` title followed by a status line: `> **Status:** Accepted design — not implemented.`
- Use sentence-case headings, relative links only, fenced code blocks with a language tag, and end Markdown files with a single trailing newline.
- Prefer tables and short sections. No marketing language, no empty placeholder pages.
- Record significant architectural decisions as ADRs in `docs/architecture/decisions/` using `template.md`. Supersede ADRs; never delete or rewrite accepted ones.
- When changing contributor workflows, update `.agents/` (then `pnpm agents:sync`) and `docs/contributing/` together.

See the `documentation` skill.
