# Documentation

- Update documentation in the same change whenever a public API, diagnostic code, CLI behavior, package boundary, or architectural contract changes. Relevant places: `docs/reference/`, `docs/architecture/`, package READMEs, `docs/roadmap.md`, and `docs/architecture/status-model.md`.
- Never describe an unimplemented capability as working. Label status with exactly one of: **Implemented**, **Accepted design**, **Proposed**, **Planned** (defined in [status-model.md](../../docs/architecture/status-model.md)). When unsure, choose the weaker status.
- Only the items listed as Implemented in the status model exist today. Providers and bindings for external infrastructure (only the runtime's default environment binding and the local binding in `@holqa/local` exist), worker isolation, reloads, topics, client generation, bundling, `@holqa/testing` beyond type assertions, and CLI workflow commands other than `holqa inspect` and `holqa build --manifest` (`holqa dev`, `invoke`, `doctor`, ...) are not implemented.
- Introduce code that uses unimplemented APIs with: "The following code is illustrative. The API is proposed, not implemented, and may change."
- Never show command output or test results that were not produced by actually running the command.
- Present Holqa as an independent, infrastructure-agnostic framework. Do not name or imply a proprietary or first-party hosting product, and do not center a single cloud vendor.
- Every concept and architecture document starts with one `#` title followed by a status line: `> **Status:** Accepted design — not implemented.`
- Use sentence-case headings, relative links only, fenced code blocks with a language tag, and end Markdown files with a single trailing newline.
- Prefer tables and short sections. No marketing language, no empty placeholder pages.
- Record significant architectural decisions as ADRs in `docs/architecture/decisions/` using `template.md`. Supersede ADRs; never delete or rewrite accepted ones.
- When changing contributor workflows, update `.agents/` (then `pnpm agents:sync`) and `docs/contributing/` together.

See the `documentation` skill.
