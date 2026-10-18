---
name: documentation
description: Standards for writing and updating Holqa's documentation - READMEs, concept and architecture docs, reference pages, ADRs, examples, and contributor docs - including the Implemented/Accepted design/Proposed/Planned status labels, honesty rules for illustrative code and unimplemented CLI commands, infrastructure-neutral wording, link and Markdown conventions, and which docs to update when contracts change. Use when creating or editing any Markdown under docs/, examples/, skills/, packages/*/README.md, or root docs, when writing an ADR, or when a code change alters a public API, diagnostic code, CLI behavior, or package boundary.
---

# Documentation

## Purpose

Holqa's documentation describes a framework that is mostly not built yet. It is only useful if every reader, human or agent, can tell exactly what exists. This skill gives the structure, the status vocabulary, and the update rules.

## When to use

- Writing or editing any Markdown file.
- Recording an architectural decision.
- Any code change to public APIs, diagnostic codes, CLI behavior, package layout, or contributor workflows (docs must change in the same PR).

## Map

| Location | Content |
| --- | --- |
| `README.md`, `CONTRIBUTING.md`, `SECURITY.md` | Project entry points |
| `AGENTS.md` (+ `CLAUDE.md` importing it) | Concise agent essentials |
| `docs/index.md`, `docs/roadmap.md` | Docs home and phased roadmap |
| `docs/getting-started/` | What a newcomer can actually run today |
| `docs/concepts/` | Vision, application model, resource graph, schemas, triggers, providers, local dev, agent-native development, security |
| `docs/architecture/` | Overview, package boundaries, compiler, status model, `decisions/` (ADRs) |
| `docs/integrations/` | Planned framework integrations |
| `docs/reference/` | `packages.md`, `diagnostic-codes.md`, `cli.md` (precise, current facts only) |
| `docs/contributing/` | Development, code style, testing, releasing, agent instructions |
| `packages/*/README.md` | Package purpose, status, public API summary |
| `examples/` | Example structure; only `package-smoke` executes |
| `skills/` | Public skills for Holqa users; `.agents/` for contributors |

## Status labels

Use exactly these bold terms (defined in [status-model.md](../../../docs/architecture/status-model.md)):

| Label | Use when |
| --- | --- |
| **Implemented** | Exists in this repo, exported or runnable, tested |
| **Accepted design** | Agreed direction (ADR `Accepted` or explicit decision), no code |
| **Proposed** | Plausible, needs validation |
| **Planned** | On the roadmap, not designed |

Every concept and architecture doc starts with:

```markdown
# Resource graph

> **Status:** Accepted design — not implemented.
```

Mixed docs summarize in the status line and label individual rows or sections.

## Honesty rules

- Write unimplemented behavior as intent: "Holqa is designed to retry failed deliveries", not "Holqa retries".
- Put this sentence immediately before code that uses APIs that do not exist (`staticSite`, generated clients, infrastructure bindings, `holqa openapi generate`, ...):

  > The following code is illustrative. The API is proposed, not implemented, and may change.

- CLI: `holqa --help`, `--version`, `--json`, `inspect`, `build --manifest`, `dev`, `invoke`, `queue send`, `storage put`, `cron run`, `state` and `doctor` work. `build` without `--manifest` and `openapi generate` exit 1 with `HOLQA_CLI_NOT_IMPLEMENTED`; unknown commands exit 2 with `HOLQA_CLI_UNKNOWN_COMMAND`. `holqa dev` reloads by restarting a process; module-level hot-swapping is Planned.
- Never paste output you did not produce by running the command. Prefer describing output over fabricating it.
- Never upgrade a status without the evidence the status model requires. When unsure, use the weaker label.
- Present Holqa as independent and infrastructure-agnostic. Do not name or imply a proprietary or first-party hosting product, and do not center one cloud vendor; use neutral terms ("an S3-compatible object store") or several examples.
- License: Apache-2.0, pending owner confirmation before public release. Never claim a legal review.

## Markdown conventions

- One `#` title, sentence-case headings, no skipped levels.
- Relative links only (`../architecture/overview.md`), never absolute GitHub URLs for in-repo files. Link to files that exist; check paths after moving docs.
- Fenced code blocks always carry a language (`ts`, `bash`, `json`, `text`, `markdown`).
- Prefer tables and short sections; no marketing language, no filler, no empty placeholder pages.
- End every Markdown file with exactly one trailing newline.
- Markdown is not linted by ESLint, so review formatting yourself.

## ADRs

1. Copy [template.md](../../../docs/architecture/decisions/template.md) to `docs/architecture/decisions/NNNN-short-title.md` with the next number.
2. Fill status (`Proposed`, `Accepted`, `Superseded`, `Deprecated`), context, decision, consequences, and alternatives.
3. State explicitly which parts, if any, are implemented. An `Accepted` ADR means Accepted design, not shipped.
4. Add it to [decisions/README.md](../../../docs/architecture/decisions/README.md).
5. To change a decision, write a new ADR that supersedes the old one and update the old one's status line; never rewrite history.

## What to update when code changes

| Change | Update |
| --- | --- |
| New/changed export | `docs/reference/packages.md`, package README, JSDoc |
| New diagnostic code | `docs/reference/diagnostic-codes.md` |
| CLI behavior | `docs/reference/cli.md`, `proposedCommands` summaries |
| Something becomes Implemented | `docs/architecture/status-model.md` table, `docs/roadmap.md`, relevant concept doc status |
| Package added or dependency direction changed | `docs/architecture/package-boundaries.md`, `docs/reference/packages.md` |
| Contributor workflow or tooling | `docs/contributing/*`, `.agents/` rules/skills (then `pnpm agents:sync`), `AGENTS.md` if essential |

## Examples

- `examples/package-smoke` is the only executable example; it runs in `pnpm test`.
- `examples/basic-backend` and `examples/fullstack-vite` show intended structure. Mark every file as illustrative and never claim they run.

## Verification checklist

- [ ] Every new doc has a title and status line; every capability mentioned has an accurate label.
- [ ] Illustrative code is introduced with the standard sentence.
- [ ] No fabricated output; no proposed CLI command described as working.
- [ ] No vendor-centric or proprietary-hosting language.
- [ ] Relative links resolve (`ls` the targets); code fences have languages; single trailing newline.
- [ ] Reference docs, status model, and roadmap updated for any contract change.
- [ ] If `.agents/` changed: `pnpm agents:sync` and `pnpm agents:check` pass.

## References

- ADRs: https://adr.github.io
- Local: [docs/architecture/status-model.md](../../../docs/architecture/status-model.md), [docs/architecture/decisions/README.md](../../../docs/architecture/decisions/README.md), [docs/contributing/agent-instructions.md](../../../docs/contributing/agent-instructions.md), [docs/roadmap.md](../../../docs/roadmap.md), [docs/index.md](../../../docs/index.md)
- Related skills: `holqa-architecture`, `release-management`
