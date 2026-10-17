# Agent instructions

How the instructions for coding agents are organized in this repository, and how to change them. The reasons are in [ADR 0008](../architecture/decisions/0008-agent-instructions-and-skills.md).

## Layout

```text
AGENTS.md                      canonical root instructions (all agents)
CLAUDE.md                      imports AGENTS.md via a line "@AGENTS.md", plus Claude-specific notes
.agents/                       CANONICAL: edit here
├── rules/<topic>.md           scoped rules (frontmatter `paths:` globs)
└── skills/<name>/SKILL.md     contributor skills (Agent Skills format)
.claude/                       Claude Code directory
├── rules/                     GENERATED mirror of .agents/rules: do not edit
├── skills/                    GENERATED mirror of .agents/skills: do not edit
├── agents/*.md                Claude-only: reviewer subagents (not mirrored)
└── settings.json              Claude-only, if present (not mirrored)
skills/                        PUBLIC skills for developers using Holqa (not mirrored)
├── README.md
└── <name>/SKILL.md
```

| Path | Audience | Canonical? | Maintained by |
| --- | --- | --- | --- |
| `AGENTS.md` | Every agent working on Holqa | Yes | Hand-edited |
| `CLAUDE.md` | Claude Code | Yes (imports `AGENTS.md`) | Hand-edited, kept short |
| `.agents/rules/`, `.agents/skills/` | Contributor agents | Yes | Hand-edited |
| `.claude/rules/`, `.claude/skills/` | Claude Code | **No, mirror** | `pnpm agents:sync` |
| `.claude/agents/` | Claude Code | Yes | Hand-edited, Claude-only format |
| `skills/` | Developers building apps with Holqa | Yes | Hand-edited, portable format |

## Sync and check

```bash
pnpm agents:sync    # bun scripts/agents-sync.ts --write
pnpm agents:check   # bun scripts/agents-sync.ts --check
```

- `agents:sync` copies every file under `.agents/rules/` and `.agents/skills/` into `.claude/` **byte-for-byte**, and deletes mirror files that no longer exist in `.agents/`. It uses copies rather than symlinks, so the mirror works on every platform.
- `agents:check` lists each `missing`, `changed` or `stale` file under `.claude/` and exits non-zero if anything differs. It also fails if `AGENTS.md` or `CLAUDE.md` is missing, or if `CLAUDE.md` has no line that is exactly `@AGENTS.md`. It is part of `pnpm check` and CI.
- Only `rules/` and `skills/` are mirrored. Everything else under `.claude/` is never touched.

Workflow: edit under `.agents/`, run `pnpm agents:sync`, and commit both trees in the same change.

## Root instruction files

`AGENTS.md` holds only persistent essentials: what Holqa is, the stack, where the authoritative docs are, mandatory code-style and testing rules, the documentation-comment requirement, using the relevant skills, running checks, never claiming unimplemented capabilities, and keeping core packages provider-neutral. Anything longer belongs in `docs/` (explanations) or a skill (procedures). Keep `CLAUDE.md` to the `@AGENTS.md` import and the few notes that only apply to Claude Code.

## Adding a rule

Rules are short, enforceable conventions for one area. Create `.agents/rules/<topic>.md`:

```markdown
---
paths:
  - "packages/core/src/**"
  - "packages/compiler/src/**"
---

# Runtime neutrality

- Do not import `bun`, `bun:*` or `node:*` in these packages.
- Report expected failures as `Result<T, Diagnostic>` with a registered `HOLQA_*` code.
```

- `paths:` takes globs relative to the repository root. The rule loads only when the agent works on matching files. Omit `paths:` only for rules that apply everywhere, and keep those rare, because they cost context on every task.
- Write checkable statements ("must not import `node:*`"), not motivation. Link to `docs/` for the reasoning.
- Run `pnpm agents:sync`.

## Adding a contributor skill

Skills are reusable procedures that an agent loads when its task matches. They use the [Agent Skills](https://agentskills.io) format:

```text
.agents/skills/<name>/
├── SKILL.md
└── references/…        optional supporting files, linked from SKILL.md
```

```markdown
---
name: schema-design
description: Use when designing or changing schemas for Holqa contracts, including Standard Schema usage, Zod integration, portable representations, and safe transformations.
---

# Schema design
…instructions, repository conventions, commands, examples, verification checklist, links…
```

- The **folder name must equal `name`**: lowercase letters, digits and hyphens.
- `description` says **when to use the skill**. Agents choose skills from this text alone, so name the tasks, files and keywords that should trigger it. Keep it to one or two sentences.
- The body includes: clear steps, the relevant conventions, correct commands, at least one example, and a verification checklist (for example `pnpm check`).
- Do not reference scripts or commands that do not exist. Label future guidance explicitly (for example "`holqa inspect` is proposed and not implemented").
- Prefer extending an existing skill to creating a near-duplicate one.
- Run `pnpm agents:sync`.

## Claude-only files

Formats that only Claude Code understands live directly under `.claude/` and are not mirrored:

- `.claude/agents/*.md`: focused reviewer subagents (`architecture-reviewer`, `type-safety-reviewer`, `test-compat-reviewer`, `docs-reviewer`). Each has frontmatter (`name`, `description`, and optionally `tools`) and a system prompt. Edit these in place.
- `.claude/settings.json`, if added: Claude Code project settings.

Do not put Claude-only files in `.agents/`. They would be mirrored and would mislead other agents.

## Public skills vs contributor skills

| | `.agents/skills/` | `skills/` |
| --- | --- | --- |
| Audience | Agents developing **Holqa itself** | Agents helping developers **use Holqa** in their apps |
| Content | Repository conventions, pnpm, Turborepo, Bun, testing, release procedures | Defining resources, handlers, local development, schema evolution |
| Mirrored to `.claude/` | Yes | No |
| Distributed | No | Intended to be distributed in the future (not published yet) |
| Status labelling | Describes the repository as it is | Must mark proposed APIs and CLI commands as **not implemented** |

Public skills must stay portable: no Claude-specific frontmatter or tools. Because the SDK and most CLI commands do not exist, public skills currently describe intended workflows and label every unimplemented step. See [`skills/README.md`](../../skills/README.md).

## Checklist

- [ ] Edited `.agents/`, not `.claude/rules` or `.claude/skills`.
- [ ] Folder name matches `name`, and `description` says when to use the skill.
- [ ] Rules have `paths:` unless they really apply everywhere.
- [ ] No unimplemented capability is described as working.
- [ ] `pnpm agents:sync` has been run, and `pnpm agents:check` and `pnpm lint` pass.
