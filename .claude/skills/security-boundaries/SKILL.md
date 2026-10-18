---
name: security-boundaries
description: Security review procedure for Holqa contributions - secret handling, trust boundaries and runtime validation of untrusted input, evaluation of untrusted user configuration, browser-safe public contracts, destructive infrastructure and repository actions, dependency and supply-chain safety, and safe agent behavior. Use when reviewing or writing code that handles input, configuration, environment variables, secrets, generated clients, file or process access, dependencies, or anything that could delete or change infrastructure or data. Named to avoid clashing with tools' built-in security-review commands.
---

# Security boundaries

## Purpose

Holqa will eventually read user configuration, validate messages, generate browser clients, and drive infrastructure tooling. Each of these is a trust boundary. This skill is a checklist-driven review for contributions today (mostly tooling, core contracts, and the CLI) and for the designs that will follow.

## When to use

- Code that parses or validates external data, config, CLI arguments, or files.
- Anything that reads environment variables or secrets.
- Designs for generated clients, the compiler's configuration loading, runtime drivers, or providers.
- Adding dependencies or changing `pnpm-workspace.yaml` supply-chain settings.
- Any action that deletes, overwrites, or rewrites (files, git history, infrastructure).

## Trust boundaries in Holqa

| Boundary | Untrusted side | Rule |
| --- | --- | --- |
| HTTP/RPC input (planned) | Request params, headers, bodies | Validate with the declared schema before handler code runs |
| Queue messages, storage events (planned) | Payloads, possibly from older deployments | Validate on consume; treat schema mismatch as a diagnostic, not a crash |
| User configuration (`infra.ts` and handler modules) | Arbitrary project code | Do not claim evaluation is sandboxed or safe unless it is. `holqa inspect` and `holqa build` evaluate modules (ADR 0014) in a separate Bun process with an allowlisted environment, a timeout and a validated IPC report; that is **not** a sandbox (file system and network stay reachable), so document that compiling runs application code |
| CLI arguments and files | User input | Parse explicitly; never pass to a shell; report diagnostics |
| Generated clients (planned) | Shipped to browsers | Contain only public contracts; never handlers, internal functions, secrets, or env values |
| Dependencies | Third-party code | Minimal, reviewed, no casual build-script approvals |

## Instructions

### Secrets

- Never hardcode credentials or tokens, including in tests, fixtures, examples, and docs. Use obvious placeholders (`DATABASE_URL=postgres://user:password@localhost:5432/app` only in `.env.example`).
- `.env` and `.env.*` are gitignored; `.env.example` is the only committable variant.
- Never print, log, or include secret values in diagnostics, error messages, `--json` output, manifests, snapshots, or summaries. Refer to secrets by name only.
- Design: secrets are declared resources (illustrative `secret(schema)`); their **names and schemas** may appear in manifests, their **values** never.
- As an agent, do not open `.env` files or credential stores unless the task requires it, and never echo their contents.

### Validation

- Accept `unknown` at the boundary; narrow with a parser that returns `Result<T, Diagnostic>` (see `parseResourceId`).
- Reject rather than coerce. Do not silently default missing or malformed security-relevant fields.
- Bound sizes and lengths where it matters (`maxResourceIdLength` = 63 is an example).
- Error messages may echo user input only when it is not sensitive; never echo secrets.

### Untrusted execution

- No `eval`, `new Function`, or dynamic `import()` of user-controlled paths in neutral packages.
- Spawning processes: pass argument arrays (`Bun.spawnSync(["bun", bin, "--help"])`), never shell strings built from input.
- Any future config loader must document what it executes and with what permissions.

### Destructive actions

- Never silently delete or replace infrastructure or data. Removing a declaration is not authorization to delete physical resources; future tooling must require explicit, reviewable confirmation and should default to dry runs/plans.
- Runtime drivers must not require provisioning permissions.
- As an agent: no `git push --force`, history rewrites, branch deletion, `rm -rf` outside build outputs (`dist`, `.turbo`, `node_modules/.cache`), publishing, or repository-setting changes without explicit user instruction.

### Supply chain

- Keep `trustPolicy: no-downgrade` and pnpm's minimum release age. Report failures; do not bypass them.
- Review a dependency's install scripts before approving builds.
- Prefer zero-dependency implementations for small utilities in `core`.

### Reporting

Suspected vulnerabilities go through [SECURITY.md](../../../SECURITY.md), not public issues, commits, or PR descriptions.

## Example review notes

```text
packages/cli/src/run.ts
- argv is parsed by exact flag matching; no shell or file access. OK.
- Error output includes the unknown command text. Acceptable: CLI args are not secrets,
  but future commands that accept credentials must not echo them.
```

## Verification checklist

- [ ] No secrets or real credentials in code, tests, fixtures, docs, output, or commit messages.
- [ ] Every untrusted input is validated at its boundary with an explicit diagnostic on failure.
- [ ] No unsandboxed evaluation is described as safe; no shell strings built from input.
- [ ] Browser-facing code exposes only public contracts.
- [ ] No destructive action is performed or designed to happen without explicit confirmation.
- [ ] Supply-chain settings unchanged, or the change is justified and reviewed.
- [ ] `pnpm check` passes and the summary lists any residual risks honestly.

## References

- OWASP Top 10: https://owasp.org/www-project-top-ten/
- OWASP Input Validation Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Input_Validation_Cheat_Sheet.html
- pnpm supply-chain settings: https://pnpm.io/settings
- Local: [docs/concepts/security.md](../../../docs/concepts/security.md), [SECURITY.md](../../../SECURITY.md), [docs/concepts/infrastructure-providers.md](../../../docs/concepts/infrastructure-providers.md)
- Related skills: `resource-contracts`, `holqa-architecture`, `pnpm-turborepo`
