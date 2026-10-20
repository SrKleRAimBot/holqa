# Bun runtime and compatibility

- Bun (version pinned in `.bun-version`, currently 1.3.13) is Holqa's runtime for the CLI and maintainer scripts and the repository's test runner. pnpm is the only package manager.
- Never run `bun install`, `bun add`, `bun remove`, `bun update`, or `bun pm`. Never commit `bun.lock`, `bun.lockb`, `package-lock.json`, or `yarn.lock`. Use `pnpm add` / `pnpm install`.
- Use Bun APIs (`Bun.*`, `bun:*`) only in packages allowed to depend on a runtime (`cli`, `runtime-bun`, future `local`, `testing`), in `scripts/`, and in tests. Keep `core`, `compiler`, `sdk`, and `client` source runtime-neutral (no `bun`, `bun:*`, `node:*` imports); ESLint enforces this.
- Library code in neutral packages must run on any standards-compliant JavaScript runtime: use Web-standard APIs (`fetch`, `Request`, `Response`, `URL`, `TextEncoder`, `crypto.subtle`) rather than runtime-specific ones.
- Use the global `process` and `Buffer`; never import them from `node:process` / `node:buffer` (`node/prefer-global` rule).
- Write tests with `bun:test`. Run them through `pnpm test` or a package's `test` script, not with ad-hoc runners.
- Do not rely on Bun-only behavior in code that Node consumers may load. Built packages declare `engines.node >=22.13.0`; only `@holqa/cli` declares `engines.bun`.
- Prefer pure-JavaScript dependencies. Do not add native addons (`.node`, node-gyp, postinstall builds) without an ADR-level justification and a Bun compatibility check.
- Do not assume Bun's watch/hot-reload behavior (`--watch`, `--hot`) is part of Holqa's runtime contract. `holqa dev` reloads by restarting a generation process ([ADR 0025](../../docs/architecture/decisions/0025-dev-supervisor-and-process-generations.md)) or, for handler-only changes, by replacing handlers in the running process through the runtime's versioned handler registry, with modules rebundled by Bun's bundler, not `--hot` ([ADR 0028](../../docs/architecture/decisions/0028-hot-handler-replacement.md)). Module unloading is planned, not implemented: old module copies stay in memory until the process restarts.
- When you rely on a Bun API, check its stability in the Bun docs for the pinned version and note any Node difference in code comments or docs.
- Changing `.bun-version` invalidates the Turborepo cache (`globalDependencies`) and must be called out in the change summary.

See the `bun-runtime` skill and [ADR 0002](../../docs/architecture/decisions/0002-bun-as-primary-runtime.md).
