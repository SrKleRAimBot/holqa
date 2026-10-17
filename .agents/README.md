# Agent instructions for contributors

This directory holds the shared, tool-neutral instructions that AI coding agents use when developing Holqa itself. It is the **canonical** source. Instructions for agents building applications *with* Holqa live in the top-level [`skills/`](../skills/README.md) directory instead and are not mirrored.

## Layout

| Path | Purpose |
| --- | --- |
| `rules/*.md` | Short, enforceable rules. Files with a `paths:` frontmatter list apply only when working on matching files; files without `paths` always apply. |
| `skills/<name>/SKILL.md` | Reusable procedures in the portable [Agent Skills](https://agentskills.io) format (`name` + `description` frontmatter only). Longer material lives in `skills/<name>/references/`. |

Root instructions live in [`AGENTS.md`](../AGENTS.md). [`CLAUDE.md`](../CLAUDE.md) imports it with a line containing exactly `@AGENTS.md`.

## Canonical vs. mirror

`.agents/rules/` and `.agents/skills/` are copied byte-for-byte into `.claude/rules/` and `.claude/skills/` so that Claude Code discovers the same files. Copies are used instead of symlinks because symlinks are unreliable on some platforms and tools.

- Edit files **only** under `.agents/`. Never edit `.claude/rules/` or `.claude/skills/` directly; the next sync overwrites or deletes those edits.
- Claude-only files (for example `.claude/agents/*.md` reviewer subagents and `.claude/settings.json`) live outside the mirrored subset and are never touched by the sync.

## Commands

```bash
pnpm agents:sync    # copy .agents/{rules,skills} into .claude/, deleting stale mirror files
pnpm agents:check   # fail if the mirror drifted or CLAUDE.md does not import AGENTS.md
```

Both run [`scripts/agents-sync.ts`](../scripts/agents-sync.ts) with Bun. `pnpm check` runs `agents:check` as part of the full quality gate, so commit the synchronized `.claude/` files together with your `.agents/` changes.

## Adding or changing a skill

1. Create `.agents/skills/<name>/SKILL.md`. `<name>` is lowercase letters, digits and hyphens, and must equal the `name` field.
2. Write a `description` (at most 1024 characters) that says what the skill does **and** when to use it.
3. Use only portable frontmatter fields. Do not add tool-specific fields.
4. Reference only scripts and features that exist. Label anything else as future guidance.
5. Run `pnpm agents:sync`, then `pnpm agents:check`.

## Adding or changing a rule

Keep each rule file short (roughly 15–40 lines), written as imperative bullets that can be checked in review. Add a `paths:` list of globs when the rule only matters for specific files. Then run `pnpm agents:sync`.

See [docs/contributing/agent-instructions.md](../docs/contributing/agent-instructions.md) and [ADR 0008](../docs/architecture/decisions/0008-agent-instructions-and-skills.md) for the rationale.
