---
"@holqa/bindings": minor
"@holqa/cli": minor
"@holqa/core": minor
"@holqa/rabbitmq": minor
"@holqa/s3": minor
---

Add provisioning, separate from runtime bindings. `@holqa/core` defines the provisioner protocol (`Provisioner`, `PlannedChange` with `create`, `update`, `replace`, `delete` and `none` actions) and the codes `HOLQA_PROVISIONING_CONFIG_INVALID`, `HOLQA_PROVISIONING_FAILED` and `HOLQA_PROVISIONING_DESTRUCTIVE`. `@holqa/bindings` adds `defineProvisioning`, `planProvisioning` (read-only, classified plans that list unprovisioned resources) and `applyProvisioning`, which applies nothing when a plan has a destructive change that was not authorized. `rabbitmq.provisioner` declares queue topologies, notification exchanges and subscription queues; `s3.provisioner` creates buckets and maintains a notification rule it owns. `holqa provision plan` and `holqa provision apply [--allow-destructive]` run them with administrative credentials in a separate process. Removing a resource declaration never plans a deletion.
