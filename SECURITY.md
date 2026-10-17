# Security policy

## Supported versions

Holqa has not published a release. Security fixes are applied to the `main` branch.

## Reporting a vulnerability

Please **do not** open a public issue for security problems.

Report vulnerabilities privately through
[GitHub private vulnerability reporting](https://github.com/SrKleRAimBot/holqa/security/advisories/new). Include:

- A description of the issue and its impact.
- Steps or code to reproduce it.
- Affected packages, files, or commits.

We aim to acknowledge reports within five business days and will keep you informed while we investigate and fix the
issue. We will credit reporters who wish to be credited once a fix is available.

## Scope

Holqa will eventually handle secrets, evaluate application configuration at build time, and plan infrastructure
changes. Its security principles (trust boundaries, secret handling, untrusted build-time execution, and protection
against destructive infrastructure changes) are documented in [docs/concepts/security.md](docs/concepts/security.md).
Reports about gaps between those principles and the implementation are welcome.
