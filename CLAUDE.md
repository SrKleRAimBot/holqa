# Claude Code instructions

@AGENTS.md

## Claude-specific notes

- `.claude/rules/` and `.claude/skills/` are generated mirrors of `.agents/`. Edit `.agents/` and run
  `pnpm agents:sync`; `pnpm agents:check` fails on drift.
- Reviewer subagents live in `.claude/agents/` (architecture, type safety, tests and compatibility, documentation).
