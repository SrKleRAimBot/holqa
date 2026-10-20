---
"@holqa/cli": minor
"@holqa/conformance": minor
---

Add `holqa providers test`, which runs conformance suites against configured providers from a module exporting `defineProviderTests([providerTest(name, suite, harness), ...])`, in a separate process with the environment's credentials, with a time limit per case and a `holqa.provider-tests/1` JSON report; it exits with 1 when a case fails. `@holqa/conformance` adds `defineProviderTests`, `providerTest` (which type-checks the harness against the suite) and `runProviderTests`.
