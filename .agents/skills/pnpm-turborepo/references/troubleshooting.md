# pnpm and Turborepo troubleshooting

## `Failed to switch pnpm to v12.14.0`

```text
ERROR  Failed to switch pnpm to v12.14.0. Looks like pnpm CLI is missing at ".../.tools/pnpm/12.14.0/bin" or is incorrect
spawnSync .../.tools/pnpm/12.14.0/bin/pnpm ENOEXEC
```

**Cause:** a globally installed pnpm 10 reads `packageManager: "pnpm@12.14.0"` and tries to switch versions, but pnpm 12 ships as a native binary that pnpm 10's switcher cannot launch.

**Fix (any one):**

- Upgrade the global pnpm to 11 or later (for example through your package manager or the pnpm installer).
- Use Corepack: `corepack enable` then `corepack prepare pnpm@12.14.0 --activate`.
- One-off: `npx pnpm@12.14.0 install` (and `npx pnpm@12.14.0 <script>`).

Do not change `packageManager` to an older version to work around this.

## A new dependency version is rejected as too new

pnpm 12 enforces a minimum release age: versions published very recently are not resolved. This protects against compromised releases.

- Pick the latest version that satisfies the age requirement, or wait.
- Do not add `minimumReleaseAgeExclude` entries or lower the age without maintainer approval and a comment explaining why.

## Trust policy downgrade

`trustPolicy: no-downgrade` makes pnpm fail when a package version has weaker publishing trust evidence than earlier versions of the same package. Treat this as a possible supply-chain incident: do not bypass it. Pin the previous version and report the problem.

## Peer dependency warnings

The only accepted exception is in `pnpm-workspace.yaml`:

```yaml
peerDependencyRules:
  allowedVersions:
    eslint-plugin-path-alias>eslint: "10"
```

New exceptions need the same kind of comment recording how compatibility was verified (for example "verified by `pnpm lint`").

## Dependency build scripts blocked

pnpm does not run dependency lifecycle scripts unless approved. If a package needs one, review what the script does, then run `pnpm approve-builds` and commit the resulting configuration with a justification. Prefer dependencies that need no build step.

## Stale or missing workspace output

Symptoms: `Cannot find module "@holqa/core"`, types in a dependent package do not reflect a change you just made in `core`, or the smoke example tests old behavior.

- Packages resolve each other through `dist/`. Run through Turborepo so `^build` executes: `pnpm turbo run test --filter=...@holqa/core`.
- `pnpm --filter <pkg> test` does not build dependencies.
- If `dist/` is corrupted: `pnpm clean && pnpm build`.

## Unexpected cache hit or miss

```bash
pnpm turbo run test --filter=@holqa/compiler --dry=json   # shows inputs, hash, dependencies
pnpm turbo run test --filter=@holqa/compiler --summarize  # writes a run summary under .turbo/runs/
```

- Unexpected **hit**: a file or env var the task depends on is not in `inputs`/`env`/`globalDependencies`.
- Unexpected **miss**: a generated or volatile file (timestamps, caches) is inside the inputs. Exclude it with `"!path/**"`.
- Root `//#` tasks only see the `inputs` listed explicitly in `turbo.json`.

## Lint cache

`lint:repo` uses `--cache-location node_modules/.cache/eslint-repo`. If ESLint results look stale after a config change, run `pnpm clean` (removes `node_modules/.cache` and `.turbo`) and re-run.

## Competing lockfile appeared

Delete `bun.lock`, `bun.lockb`, `package-lock.json`, or `yarn.lock`, remove `node_modules`, and run `pnpm install`. Find and stop whatever ran the other package manager.
