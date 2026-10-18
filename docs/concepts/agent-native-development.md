# Agent-native development

> **Status:** Planned, with **Implemented** foundations. The CLI's `--json` output, the structured diagnostic model with stable `HOLQA_*` codes, and graph inspection (`holqa inspect --json`) are **Implemented**. Repository agent instructions and skills are **Implemented**. Local invocation and an MCP server are **Planned**.

Holqa is designed for both human developers and autonomous coding agents. Tooling that is predictable for an agent (structured output, stable error codes, deterministic behavior, safe defaults) is also better for humans and CI.

## What agents should eventually be able to do

| Capability | Planned mechanism | Status |
| --- | --- | --- |
| Inspect the resource graph | `holqa inspect --json` | **Implemented** |
| Understand HTTP/RPC operations and event handlers | Manifest and OpenAPI output | **Implemented** for event handlers in the manifest; HTTP/RPC operations and OpenAPI planned |
| Add a resource or handler | Public skills (`define-resources`, `add-queue-consumer`, …) | Skills drafted; framework planned |
| Infer correct types | Source-based inference ([type safety](type-safety-and-schemas.md)) | **Implemented** |
| Generate clients | Compiler client generation | Planned |
| Run local tests and simulated events | `holqa invoke`, `holqa queue send`, `@holqa/testing` | Planned |
| Diagnose compiler and runtime failures | Structured diagnostics with stable codes | **Implemented** (model, compiler and `@holqa/runtime-bun`, which logs invocation failures with their codes) |
| Inspect infrastructure requirements | Manifest capability requirements | **Implemented** |
| Generate deployment plans | Provisioning provider plans | Planned |
| Verify behavior through logs and traces | Structured logs; OpenTelemetry integration | Planned |

## Principles

1. **Structured output.** Every command that produces information or errors supports machine-readable JSON.
2. **Stable diagnostic codes.** Agents match on codes, not on message text. Codes are never renamed or reused.
3. **Deterministic behavior.** The same input produces the same output (for example, canonical JSON manifests).
4. **Explicit errors.** Failures are diagnostics with a code, severity, message, optional location, and optional hint, not stack traces.
5. **Safe defaults.** Tools never expose secrets unnecessarily and never perform destructive infrastructure changes silently.

## Implemented today

### Structured diagnostics

`@holqa/core` defines the `Diagnostic` type used everywhere:

```ts
interface Diagnostic {
  readonly code: DiagnosticCode; // for example "HOLQA_RESOURCE_ID_INVALID"
  readonly severity: "error" | "warning" | "info";
  readonly message: string;
  readonly location?: { readonly file: string; readonly line?: number; readonly column?: number };
  readonly hint?: string;
}
```

`formatDiagnostic` renders a diagnostic for humans as `file:line:col severity CODE: message`, followed by an indented `hint:` line when present. The same object serializes to JSON for agents. See [diagnostic codes](../reference/diagnostic-codes.md).

### `--json` in the CLI

The `holqa` CLI accepts `--json`. With it, errors are written to standard error as a JSON document and the exit code distinguishes failure kinds:

```bash
$ holqa dev --json
{"diagnostics":[{"code":"HOLQA_CLI_NOT_IMPLEMENTED","severity":"error","message":"\"holqa dev\" is a proposed command and is not implemented yet.","hint":"See docs/roadmap.md for implementation status."}]}
$ echo $?
1
```

`holqa --version --json` prints `{"version":"…"}`. Exit codes are `0` (success), `1` (failure, including not implemented), and `2` (usage error, such as an unknown command). See the [CLI reference](../reference/cli.md).

An agent can therefore check whether a command exists by looking for `HOLQA_CLI_NOT_IMPLEMENTED` rather than guessing from help text.

### Graph inspection

`holqa inspect --json` evaluates the application and prints one canonical JSON document with the diagnostics, the entry point map, the resource graph and the manifest. `holqa build --manifest` writes the manifest and entry point map to files. Both run the application's code; see the [CLI reference](../reference/cli.md) and the [compiler specification](../reference/compiler-specification.md).

### Repository agent instructions and skills

For contributors working on Holqa itself, the repository provides:

| Location | Purpose |
| --- | --- |
| [`AGENTS.md`](../../AGENTS.md) | Canonical root instructions. `CLAUDE.md` imports it. |
| `.agents/rules/*.md` | Scoped rules (canonical). |
| `.agents/skills/<name>/SKILL.md` | Contributor skills (canonical). |
| `.claude/rules/`, `.claude/skills/` | Byte-for-byte mirrors produced by `pnpm agents:sync`; `pnpm agents:check` fails on drift. |
| `.claude/agents/*.md` | Claude-specific reviewer subagents. |

See [agent instructions](../contributing/agent-instructions.md) and [ADR 0008](../architecture/decisions/0008-agent-instructions-and-skills.md).

### Public skills for application developers

The top-level [`skills/`](../../skills/README.md) directory holds skills intended for developers building applications with Holqa (getting started, defining resources, adding queue consumers, schema evolution, debugging events, and others). They follow portable Agent Skills conventions rather than being specific to one agent product. Because most of the framework is not implemented, these skills describe intended workflows and must clearly distinguish proposed commands from executable ones. They are not published.

## Planned

### Local MCP server

Future Holqa tooling may expose a local Model Context Protocol (MCP) server so agents can query the resource graph, read diagnostics, and trigger local invocations through tool calls rather than shell commands. It is not part of the initial implementation and has no design yet. Any such server must apply the safety rules below.

### Inspection and simulation

`holqa invoke`, `holqa queue send`, `holqa storage put`, and `holqa cron run` are proposed commands intended to give agents a closed loop: change code, simulate an event, read structured results. Together with the implemented `holqa inspect`, they would let an agent see the graph and then exercise it.

## Safety

Agent tooling must:

| Rule | Rationale |
| --- | --- |
| Never expose secret values in output, logs, manifests, or diagnostics. | Agent transcripts are often stored and shared. Show that a secret is set, not its value. |
| Never perform destructive infrastructure changes silently. | Deleting queues or buckets destroys data. Destructive operations require explicit confirmation outside the agent's autonomous loop. |
| Prefer read-only and local operations by default. | Inspection and local simulation are safe; deployment is not. |
| Fail explicitly. | An ambiguous success is worse than a clear error for an autonomous agent. |

Contributor agents in this repository are additionally instructed never to fabricate test results, to make small verifiable changes, and to run `pnpm check` before declaring success. See [security](security.md).

## Related

- [Diagnostic codes](../reference/diagnostic-codes.md)
- [CLI reference](../reference/cli.md)
- [Agent instructions](../contributing/agent-instructions.md)
- [ADR 0008: Agent instructions and skills](../architecture/decisions/0008-agent-instructions-and-skills.md)
