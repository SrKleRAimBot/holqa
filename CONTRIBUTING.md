# Contributing to Holqa

Thank you for your interest in Holqa. The project is in its bootstrap phase, so the most valuable contributions right
now are design feedback, documentation improvements, and carefully scoped foundational code.

## Before you start

- Read the [documentation index](docs/index.md), the [status model](docs/architecture/status-model.md), and the
  [roadmap](docs/roadmap.md) so you know what is implemented and what is design.
- For architectural changes, read the relevant [ADRs](docs/architecture/decisions/README.md) and open a proposal issue
  before writing code. Significant decisions are recorded as new ADRs.
- Follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Setup

```bash
pnpm install
pnpm check
```

Requirements and every available script are described in [docs/contributing/development.md](docs/contributing/development.md).
pnpm is the only package manager for this repository; do not commit `package-lock.json`, `yarn.lock`, or `bun.lock`.

## Making changes

1. Keep changes small and focused. Separate refactors from behavior changes.
2. Follow the [code style guide](docs/contributing/code-style.md). Every named function, method, and class needs a
   meaningful documentation comment.
3. Add tests under the package's `tests/` directory, mirroring `src/` ([testing guide](docs/contributing/testing.md)).
4. Update documentation when behavior or contracts change. Never describe unimplemented capabilities as available.
5. Keep core packages infrastructure-neutral and respect the
   [package boundaries](docs/architecture/package-boundaries.md).
6. For behavior changes to a non-private package, add a changeset with `pnpm changeset`
   ([releasing guide](docs/contributing/releasing.md)).
7. Run `pnpm check` before opening a pull request.

## Commits and pull requests

- Use [Conventional Commits](https://www.conventionalcommits.org/) (`feat(core): ...`, `fix(cli): ...`, `docs: ...`).
- Fill in the pull request template, including the compatibility impact of public API changes.
- CI runs `pnpm check` on every pull request.

## Using AI coding agents

Agent instructions live in [AGENTS.md](AGENTS.md) (and [CLAUDE.md](CLAUDE.md) for Claude Code). Contributors remain
responsible for every change they submit: review agent output, run the checks yourself, and never submit fabricated
test results. See [docs/contributing/agent-instructions.md](docs/contributing/agent-instructions.md).

## License

By contributing, you agree that your contributions are licensed under the [Apache License 2.0](LICENSE).
