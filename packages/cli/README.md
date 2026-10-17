# @holqa/cli

The `holqa` command-line interface.

> **Status:** Only `--help`, `--version`, and `--json` output are implemented. Every workflow command is proposed and
> reports `HOLQA_CLI_NOT_IMPLEMENTED`. Private and unpublished. Runs on Bun.

```bash
pnpm --filter @holqa/cli build
bun packages/cli/dist/bin.js --help
bun packages/cli/dist/bin.js dev --json
# {"diagnostics":[{"code":"HOLQA_CLI_NOT_IMPLEMENTED","severity":"error",...}]}
```

| Exit code | Meaning |
| --- | --- |
| `0` | Success (`--help`, `--version`). |
| `1` | A proposed command that is not implemented yet. |
| `2` | Unknown command. |

Proposed commands (`dev`, `build`, `inspect`, `doctor`, `invoke`, `queue send`, `storage put`, `cron run`,
`openapi generate`) are described in [docs/reference/cli.md](../../docs/reference/cli.md).
