# Holqa agent skills

> **Status:** Preview — these skills describe Holqa's API and CLI, part of which is implemented in private packages and part of which is **proposed**. Many workflows cannot be carried out yet. The skills are not published and must not be published until the features they describe exist.

This directory is the library of [Agent Skills](https://agentskills.io) for developers who build applications **with** Holqa. Each skill teaches a coding agent (or a human) one workflow: declaring resources, adding a queue consumer, reviewing security, and so on.

These are not the skills used to develop Holqa itself. Contributor skills live in `.agents/skills/` and are described in [`docs/contributing/agent-instructions.md`](../docs/contributing/agent-instructions.md).

## Status

Holqa is at the bootstrap stage. What exists today is limited to:

| Capability | Status |
| --- | --- |
| `holqa --help`, `--version`, `--json` (from a repository checkout; packages are private) | **Implemented** |
| Structured diagnostics with stable codes (`HOLQA_CLI_NOT_IMPLEMENTED`, `HOLQA_RESOURCE_ID_INVALID`, ...) | **Implemented** |
| Resource ID validation (`parseResourceId` in `@holqa/core`, not yet a public package) | **Implemented** |
| `@holqa/sdk` (`defineApp`, `http.api` with routes, RPC procedures and middleware, `queue`, `bucket`, `schedule`, `secret`, `variable`) | **Implemented** (private, unpublished); `staticSite` is proposed |
| `@holqa/runtime-bun` (serving HTTP routes and RPC procedures of a compiled application; delivering queue messages, object events and scheduled runs with retries and dead-lettering) | **Implemented** (private, unpublished) |
| `@holqa/local` (local queues, object storage with events and signed URLs, a clock-driven scheduler, inspection) | **Implemented** (private, unpublished) |
| `holqa inspect` (with `--cycles`), `build --manifest`, `dev`, `invoke`, `queue send`, `queue redrive`, `storage put`, `cron run`, `state`, `doctor` | **Implemented** |
| `@holqa/testing` (`createTestApp`, type assertions) | **Implemented** (private, unpublished) |
| `holqa build` (bundling), `openapi generate` | Proposed — each reports `HOLQA_CLI_NOT_IMPLEMENTED` |
| `@holqa/client`, integrations other than `@holqa/zod`, module hot-swapping | Planned |

Every skill therefore starts with a preview notice and separates **Works today** from **Planned workflow**. Code in the skills is illustrative and uses the proposed API style shown in [`docs/concepts/application-model.md`](../docs/concepts/application-model.md); names may change before release. When a skill and the implementation disagree, the implementation and the reference documentation win.

## Format

The skills follow the portable Agent Skills format and contain no tool- or vendor-specific instructions:

- One folder per skill; the folder name equals the skill's `name`.
- Each folder contains a `SKILL.md` with YAML frontmatter:
  - `name` (required): lowercase letters, digits and hyphens; matches the folder name.
  - `description` (required, at most 1024 characters): what the skill does and when to use it.
  - `license` (optional): `Apache-2.0`.
  - `metadata` (optional): free-form key/value pairs; every skill here sets `status: preview`.
- The body is Markdown: when to use, workflow steps, illustrative code, pitfalls and a verification checklist.

## Skills

| Skill | Use it to |
| --- | --- |
| [`getting-started`](./getting-started/SKILL.md) | Set up a Holqa project structure with `infra.ts` and handler modules. |
| [`define-resources`](./define-resources/SKILL.md) | Declare queues, buckets, schedules, APIs, static sites, secrets and variables with stable IDs. |
| [`create-http-endpoint`](./create-http-endpoint/SKILL.md) | Add a typed HTTP route with validated path, query, header and body inputs. |
| [`create-rpc-procedure`](./create-rpc-procedure/SKILL.md) | Add a typed RPC query or mutation and expose it through a browser-safe client. |
| [`add-queue-consumer`](./add-queue-consumer/SKILL.md) | Send messages to a queue and write an idempotent consumer. |
| [`object-storage`](./object-storage/SKILL.md) | Read and write objects, issue signed URLs and handle storage events. |
| [`local-development`](./local-development/SKILL.md) | Run the application locally with emulated resources and Vite HMR. |
| [`testing-event-driven-apps`](./testing-event-driven-apps/SKILL.md) | Test handlers deterministically, including duplicates, retries and failures. |
| [`schema-evolution`](./schema-evolution/SKILL.md) | Change message and API schemas without breaking in-flight data or clients. |
| [`debug-events`](./debug-events/SKILL.md) | Diagnose failing, retried or dead-lettered events using structured diagnostics. |
| [`validate-infrastructure-bindings`](./validate-infrastructure-bindings/SKILL.md) | Check that a provider binding satisfies every declared resource requirement. |
| [`security-review`](./security-review/SKILL.md) | Review an application for secret exposure, missing validation and unsafe clients. |

## Contributing to the skills

- Keep each skill between roughly 50 and 150 lines and focused on one workflow.
- Never describe a proposed feature as working. Move content from **Planned workflow** to **Works today** only when the feature is implemented and tested.
- Keep code consistent with [`examples/basic-backend`](../examples/basic-backend/) and [`examples/fullstack-vite`](../examples/fullstack-vite/).
