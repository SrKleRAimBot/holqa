# Provider authoring guide

> **Status:** **Implemented.** Everything this guide uses exists: the provider protocol in `@holqa/core`, `defineBindings` in `@holqa/bindings`, the conformance suites and `holqa providers test` in `@holqa/conformance` and `@holqa/cli`, and the provisioner protocol. The [RabbitMQ](../../packages/providers/rabbitmq/README.md) and [S3-compatible](../../packages/providers/s3/README.md) providers are complete examples.

A provider connects Holqa's logical resources to one implementation: a broker, an object store, an execution host or a service. This guide walks through writing one, from declaration to conformance.

## 1. Decide the role and contracts

| Role | Use when | Must declare |
| --- | --- | --- |
| `resource` | It binds one or more resource kinds, for example only queues. | At least one kind in `resources`, and its contract in `contracts`. |
| `service` | It supplies configuration, telemetry or event safety stores, or only extensions. | The services in `services`, and their contracts. |
| `platform` | It can run a whole application alone. | Every mandatory contract and every resource kind. |

Contract versions must match `bindingContracts` exactly; a provider for another version is rejected with `HOLQA_BINDING_CONTRACT_INCOMPATIBLE` before it is opened. The contracts and their semantics are in the [binding contracts reference](../reference/bindings.md#contracts-and-versions).

## 2. Write the factory

A provider factory returns frozen data and an `open` function. Calling the factory must not connect, read the environment or resolve credentials: `holqa bindings validate` and `holqa package` inspect providers without opening them.

```ts
import type { BindingProvider, CredentialReference } from "@holqa/core";
import { bindingFailure, bindingProtocolVersion, HolqaError, isCredentialReference } from "@holqa/core";

export function queues(options: { readonly url: CredentialReference }): BindingProvider<"queue"> {
  if (!isCredentialReference(options.url))
    throw new HolqaError(bindingFailure("configuration", { binding: "example", message: "\"url\" must be a credential reference." }));
  return Object.freeze({
    bindingProtocol: bindingProtocolVersion,
    provider: "example.queues",            // the implementation, namespaced
    name: "example",                       // this configured instance
    role: "resource",
    contracts: { queue: 1 },
    resources: { queue: { delivery: ["at-least-once"], maxAttempts: 10, deadLetter: true, backoff: ["fixed"], maxDelaySeconds: 60 } },
    services: {},
    topology: { delivery: "pull", state: "shared", connectors: ["a long-running consumer process"] },
    settings: { cluster: "primary" },      // non-secret, recorded in binding manifests
    credentials: [options.url],            // every credential it resolves
    open: async (context) => {
      const url = context.credential(options.url);
      // connect, check that the infrastructure exists, return drivers and sources
      return { drivers: { queue: resource => createDriver(url, resource) }, sources: { queue: resource => createSource(url, resource) } };
    }
  });
}
```

`createDriver` and `createSource` stand for your implementation.

| Rule | Why |
| --- | --- |
| Advertise only what you deliver natively. Mark emulations in `emulations`, and only when explicitly enabled. | Requirements are checked against declarations; an over-claiming provider silently weakens guarantees. |
| Take credentials only as `CredentialReference`s and list them in `credentials`. | A provider can resolve only the credentials it declares; manifests list names, never values. |
| Never create infrastructure in `open`. Fail with `HOLQA_BINDING_FAILED` when it is missing. | Runtime credentials need only data-plane permissions; creating infrastructure is provisioning. |
| Classify every failure with `bindingFailure`: `credentials-invalid`, `unavailable` (transient), `failed` (permanent), `configuration`, `capability`. | Operators and the runtime decide retries and alerts from the class. |
| Describe the topology honestly: `delivery` (`pull`, `push`, `none`) and `state` (`process`, `host`, `shared`). | Validation rejects background handlers that would never run and replica counts the state cannot serve. |
| Implement the lifecycle: `ready`, `health` and a bounded `stop` that returns unsettled deliveries. | The runtime drives start, readiness, health probes and graceful shutdown through it. |

## 3. Implement the contract semantics

The driver and source semantics are normative, for example for queues: a leased delivery is not received again while its lease lasts, settlements after the lease expired resolve to `false`, attempts are counted across retries, and delays are never shorter than asked. The [binding contracts reference](../reference/bindings.md) lists them per contract. Carry the writer's `DeliveryTrace` through your infrastructure (message headers, object metadata) so lineage and traces continue in the handler.

When infrastructure delivers notifications separately from storage, accept an `EventChannel` instead of depending on one transport, as `s3.buckets({ events: { channel } })` does.

## 4. Prove it with the conformance suites

`@holqa/conformance` has one suite per contract (`queueConformance`, `bucketConformance`, `bucketEventsConformance`, `scheduleConformance`). Run them in your package's tests against a fast in-memory fake of your infrastructure, and against the real infrastructure when it is available:

```ts
import { queueConformance, registerConformance } from "@holqa/conformance";
import { describe, it } from "bun:test";

registerConformance(queueConformance, { time, open: async () => ({ driver, source, capabilities, close }) }, { describe, it });
```

Each case gets a fresh, empty fixture from `open`; `time.advance` lets time pass (a virtual clock in fakes, real sleeping against infrastructure). Cases a provider does not support skip themselves based on the advertised capabilities.

To run suites against configured providers outside a test runner, for example in a deployment pipeline, export them from a module and use `holqa providers test`:

```ts
// conformance.ts
import { defineProviderTests, providerTest, queueConformance } from "@holqa/conformance";

export default defineProviderTests([providerTest("staging queues", queueConformance, () => stagingQueueHarness())]);
```

```bash
holqa providers test --only "staging queues" --json
```

It runs in a separate process with the environment's credentials and exits with `1` when a case fails. See the [conformance reference](../reference/conformance.md).

## 5. Optionally, write a provisioner

A provisioner creates what your runtime provider expects, with separate administrative credentials, by deriving it from the runtime provider's settings. Plans must only read, classify every change, and never delete because a declaration disappeared. See [provisioning](../reference/provisioning.md#writing-a-provisioner).

## 6. Package it

A provider package depends inward on `@holqa/core` (and `@holqa/conformance` for tests) and never the other way. Add it to `allowedDependencies` in `scripts/check-boundaries.ts` and to [package boundaries](../architecture/package-boundaries.md); `pnpm boundaries:check` enforces it.

## Related

- [Binding contracts](../reference/bindings.md)
- [Conformance](../reference/conformance.md)
- [Provisioning](../reference/provisioning.md)
- [Operations guide](operations.md)
