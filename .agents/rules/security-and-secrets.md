# Security and secrets

- Never hardcode, log, print, commit, or echo credentials, tokens, private keys, or `.env` values. `.env` and `.env.*` are gitignored; only `.env.example` with placeholder values may be committed.
- Never read secret files or environment values unless the task requires it, and never include their contents in output, diagnostics, test snapshots, commit messages, or summaries.
- Do not put secrets or environment values in manifests, generated clients, diagnostics, or error messages. Public client contracts must not expose private handlers, internal functions, or credentials.
- Validate untrusted input at trust boundaries with explicit runtime checks; never trust TypeScript types for external data.
- Do not execute user configuration or project code unsandboxed while describing evaluation as secure. Document the trust assumption instead.
- Never perform destructive infrastructure or data actions (deleting resources, dropping data, force-pushing, rewriting history, `rm -rf` outside build outputs) silently or without explicit user confirmation. Removing a resource declaration must never by itself authorize deleting physical infrastructure.
- Do not publish packages, push tags, create releases, or change repository settings unless the user explicitly asks.
- Do not add dependencies with install scripts or native builds without justification; pnpm blocks dependency build scripts unless approved, and approvals require review.
- Do not weaken supply-chain settings in `pnpm-workspace.yaml` (`trustPolicy`, minimum release age) to make an install succeed. Report the error instead.
- Swallowing errors hides failures: never catch and ignore errors silently.
- Report suspected vulnerabilities through the process in [SECURITY.md](../../SECURITY.md), not in public issues or commits.

See the `security-boundaries` skill and [docs/concepts/security.md](../../docs/concepts/security.md).
