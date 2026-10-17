# 0008. Agent instructions and skill organization

- **Status:** Accepted
- **Date:** 2026-10-17
- **Deciders:** Holqa maintainers

## Context

Coding agents are expected to contribute to Holqa. Different tools read instructions from different places:

- Many agents read a root `AGENTS.md`, and some read `.agents/` directories for rules and skills.
- Claude Code reads `CLAUDE.md`, `.claude/rules/*.md` (optionally scoped by `paths:` frontmatter), `.claude/skills/<name>/SKILL.md` and `.claude/agents/*.md`.
- Skills follow the Agent Skills format: a folder whose name matches the `name` in the `SKILL.md` frontmatter, with a `description` that tells the agent when to use it.

Keeping two hand-edited copies of the same instructions guarantees drift. Symlinks avoid duplication but break on some platforms (Windows checkouts without symlink support) and in some tools.

Two audiences need instructions:

1. **Contributors developing Holqa itself:** repository conventions, quality gates, architecture boundaries.
2. **Developers building applications with Holqa:** framework usage. Holqa intends to distribute these skills eventually.

## Decision

1. **`AGENTS.md` is the canonical root instruction file.** It is kept concise and covers only persistent essentials: identity, stack, where the docs are, mandatory rules, quality checks, and honesty about what is implemented. Long explanations go in `docs/`, and procedures go in skills.
2. **`CLAUDE.md` imports `AGENTS.md`** through a line containing exactly `@AGENTS.md`, plus any Claude-specific notes. `pnpm agents:check` fails if the import line is missing.
3. **`.agents/` is canonical for shared rules and skills.** `.agents/rules/*.md` and `.agents/skills/<name>/SKILL.md` are edited there and only there.
4. **`.claude/rules/` and `.claude/skills/` are generated mirrors.** `pnpm agents:sync` (`bun scripts/agents-sync.ts --write`) copies files byte-for-byte and deletes stale mirror files. `pnpm agents:check` (`--check`) lists missing, changed and stale files and exits non-zero on drift. It runs in `pnpm check` and CI. Copies are used instead of symlinks.
5. **Claude-only files live outside the mirrored subset**, for example `.claude/agents/*.md` (reviewer subagents: architecture, type safety, test and compatibility, documentation) and `.claude/settings.json`. The sync script never touches them.
6. **Rules are scoped** with `paths:` glob frontmatter where the tool supports it, so they load only for matching files.
7. **Public, end-user skills live in the top-level `skills/` directory.** They are not mirrored into `.agents/` or `.claude/`, and they use portable Agent Skills conventions rather than Claude-specific features. They describe proposed framework workflows and must label unimplemented commands as proposed.

This decision is in effect. The procedures are described in [agent instructions](../../contributing/agent-instructions.md).

## Consequences

### Positive

- One source of truth for shared instructions, and drift is caught automatically.
- Works for `AGENTS.md`-based agents and Claude Code without symlinks.
- Contributor tooling and the future public skill library are kept apart, so neither leaks into the other.

### Negative

- Contributors must remember to edit `.agents/` and run `pnpm agents:sync`. Editing `.claude/` directly is overwritten on the next sync and fails `agents:check`.
- Duplicated bytes in the repository (small text files only).
- Tool conventions change. Frontmatter fields or directory names may need updating as agent tools evolve.

## Alternatives considered

### Symlink `.claude/` to `.agents/`

Rejected. Symlinks are unreliable on Windows and in some archive and tool workflows, and a whole-directory symlink cannot hold Claude-only files beside the shared ones.

### Maintain `.claude/` as the canonical copy

Rejected. It would make one vendor's layout canonical for every tool. `.agents/` and `AGENTS.md` are tool-neutral.

### Put everything in `AGENTS.md`

Rejected. A long root file is loaded on every task and buries the essentials. Scoped rules and on-demand skills load only when relevant.

### Combine contributor and public skills in one directory

Rejected. They serve different audiences and have different release expectations: public skills will be distributed, contributor skills will not.

## Related

- [Agent instructions guide](../../contributing/agent-instructions.md)
- [Agent-native development](../../concepts/agent-native-development.md)
- [`scripts/agents-sync.ts`](../../../scripts/agents-sync.ts)
- [`AGENTS.md`](../../../AGENTS.md), [`CLAUDE.md`](../../../CLAUDE.md), [`skills/README.md`](../../../skills/README.md)
- Agent Skills specification: <https://agentskills.io>
