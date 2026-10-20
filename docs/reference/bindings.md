# Binding contracts

> **Status:** **Implemented** in `@holqa/core` (contract versions, the provider protocol, provider validation, failure classification, lifecycle types, per-resource capability checks; [ADR 0029](../architecture/decisions/0029-binding-provider-protocol-and-versioned-contracts.md)), `@holqa/bindings` (binding configurations, resolution and composition; [ADR 0030](../architecture/decisions/0030-binding-composition-and-resolution.md)) and `@holqa/runtime-bun` (the binding lifecycle and `runtime.health()`). The local binding in `@holqa/local` implements the resource contracts through `createLocalEnvironment`.

This page is the specification every binding implementation follows: which contracts exist, what each one guarantees, how a provider declares what it supports, how it is opened, monitored and stopped, and how its failures are reported. Application developers never implement these interfaces; they declare resources with `@holqa/sdk`, and providers fulfil them.

## Concepts

| Term | Meaning |
| --- | --- |
| Contract | One versioned area of behaviour a binding fulfils, for example `queue` or `config`. |
| Provider | One binding implementation, described by a `BindingProvider`: side-effect-free data plus `open`. |
| Provider instance | What `open` returns: drivers, sources, services and lifecycle hooks. |
| Runtime binding | What a runtime installs on an application (`RuntimeBinding`): drivers, sources, configuration, capabilities. One application instance has one. |
| Capability | Something a provider advertises (`BindingCapabilities`), compared with a resource's declared requirements. |

## Contracts and versions

`bindingContracts` lists every contract with the version this copy of Holqa implements. A provider declares a version per contract, and the versions must match exactly (`contractVersionProblem`); otherwise the provider is rejected with `HOLQA_BINDING_CONTRACT_INCOMPATIBLE` before it is opened. `bindingProtocolVersion` (`1`) versions the provider protocol itself.

| Contract | Version | Kind | Mandatory for a platform | Fulfilled through |
| --- | --- | --- | --- | --- |
| `execution` | 1 | Host | Yes | `ExecutionCapabilities`; the host runs `@holqa/runtime-bun` |
| `http.api` | 1 | Resource | Yes | `resources["http.api"]` capabilities; the runtime routes requests |
| `queue` | 1 | Resource | Yes | `drivers.queue`, `sources.queue` |
| `bucket` | 1 | Resource | Yes | `drivers.bucket` |
| `bucket.events` | 1 | Resource | Yes | `sources.bucket`, `resources.bucket.events` |
| `schedule` | 1 | Resource | Yes | `sources.schedule` |
| `config` | 1 | Service | Yes | `ConfigSource` |
| `telemetry` | 1 | Service | Yes | `TelemetryExporter` list |
| `idempotency` | 1 | Service | No | `IdempotencyStore` |
| `operation-budgets` | 1 | Service | No | `OperationBudgetStore` |

### `execution`

The host that runs Holqa's invocation engine (`createRuntime` in `@holqa/runtime-bun`). A provider does not reimplement the engine: dispatching, validation, middleware, time limits, cancellation, retries and event safety are shared by every binding ([runtime reference](runtime.md)). The provider advertises `ExecutionCapabilities`:

| Field | Meaning |
| --- | --- |
| `runtimes` | Runtimes the host runs, for example `["bun"]`. |
| `mode` | `long-running`: processes stay up and can consume sources in the background. `request-driven`: processes run only while serving requests, so background delivery needs a provider that pushes events or a separate worker. |
| `maxTimeoutMs`, `maxConcurrency` | Limits the host imposes; absent means none. |

### `http.api`

The runtime serves HTTP APIs and RPC procedures with standard Fetch `Request` and `Response` objects (`runtime.fetch`), so any server, proxy or gateway that can produce a `Request` can host them. Routing, validation, middleware order, typed responses, error bodies, cancellation on client disconnect (through the request's `signal`) and correlation and trace headers are specified in the [runtime reference](runtime.md#http-routes) and identical for every provider. `HttpApiCapabilities` has no fields yet.

### `queue`

| Part | Obligation |
| --- | --- |
| `drivers.queue(resource).send(envelope, options, context)` | Store the `holqa.message/1` envelope unchanged and resolve with `{ messageId }` once the message is accepted (durably, when the provider claims durability). Keep `context.trace` with the message. Honour `options.delaySeconds` exactly or later, never earlier; a delay beyond the advertised `maxDelaySeconds` never reaches the driver. |
| `sources.queue(resource)` | A `QueueSource`: lease due messages (`receive`), and settle them with `acknowledge`, `retry(delayMs)`, `deadLetter` and `discard`. A lease that expires makes the message due again with a higher `attempt`. Every settlement resolves to `false` when the lease was lost. `extend` renews a lease; `wait` resolves when work may be due. `defaultMaxAttempts` applies to queues that declare none. |
| Delivery | At least once. Duplicates must carry the same `messageId`. Ordering is not guaranteed. |
| Policy | Retries, backoff, dead-lettering and discarding are decided by the runtime, never by the provider, so they behave the same on every binding. |

`QueueCapabilities`: `delivery` (`["at-least-once"]`), `maxAttempts`, `deadLetter`, `backoff` (strategies the provider can delay for), `maxDelaySeconds`.

### `bucket`

`drivers.bucket(resource)` implements `put` (resolves to metadata with an opaque `etag`), `get`, `head`, `delete` (resolves to `false` when the object did not exist), `list` (pages of at most 1 000 keys in UTF-8 byte order with an opaque cursor) and `signUrl`. Keys are validated before a driver sees them (`checkObjectKey`). Objects are opaque bytes with an optional `contentType`. `BucketCapabilities`: `access` (`private`, `public-read`), `signedUrls.maxExpiresInSeconds` (absent: no signed URLs).

### `bucket.events`

`sources.bucket(resource).subscribe(subscription)` returns a delivery source of `holqa.object-event/1` events for one handler's subscription (types and optional prefix). Every subscription settles its own copy. Event identifiers are stable across redeliveries. A provider advertises the event types it delivers in `BucketCapabilities.events`, and declares the `bucket.events` contract only when it does: reading and writing objects never implies event delivery. Against external services, a subscription is infrastructure created by provisioning; `subscribe` must fail with a classified failure when it is missing, never create it with data-plane credentials.

### `schedule`

`sources.schedule(resource).start(listener)` reports due runs; the listener's promise resolves with the run's result, which the scheduler may record. The provider evaluates cron, time zone, daylight-saving and missed-run rules exactly as the [runtime reference](runtime.md#scheduled-runs) specifies, or refuses the schedule. The overlap policy is applied by the runtime per process. `ScheduleCapabilities`: `overlap`.

### `config`

A `ConfigSource` returns raw string values by name (`lookup`) and may re-read them (`refresh`) for rotation. Holqa applies declared defaults and validates every configuration entry against its schema the same way for every source, and reports problems with `HOLQA_CONFIG_INVALID` without secret values. Credential references (`credentialRef`) in provider settings are resolved through the same service.

### `telemetry`

A list of `TelemetryExporter`s ([observability](../concepts/observability.md)). Exporters run in the runtime's bounded background pipeline; a failing exporter loses only its own batches and never affects invocations.

### `idempotency` and `operation-budgets`

The shared stores of [event safety](../concepts/event-safety.md). Optional: an application that needs one (a handler with an `idempotency` policy, `events.maxEventsPerOperation`) is rejected by a binding without it. A store must be atomic across every process that serves the application; a provider that cannot guarantee that must not supply it.

## Providers

A provider is created by a factory (for example `local.platform()`), which must not connect to anything. Everything except `open` is data that tools validate and record:

| Field | Meaning |
| --- | --- |
| `bindingProtocol` | `1`. |
| `provider` | The implementation's namespaced identifier: at least two dot-separated lowercase segments, for example `holqa.local` or `example.queue`. |
| `name` | This configured instance's name, for diagnostics and manifests, for example `rabbitmq.orders`. |
| `role` | `platform` (every mandatory contract and every resource kind), `resource` (one or more kinds) or `service` (services only). |
| `contracts` | The version of each contract implemented. |
| `resources` | Capabilities per bound resource kind. A kind that is absent is not bound. |
| `services` | `{ config: true, telemetry: true, ... }` for the services supplied. |
| `execution` | `ExecutionCapabilities`, exactly when the `execution` contract is declared. |
| `emulations` | Capabilities fulfilled through an explicitly enabled compatibility layer: `kind`, `capability`, `mechanism`, `requires`. |
| `topology` | `delivery` (`pull`, `push`, `none`), `state` (`process`, `host`, `shared`) and `connectors` (background processes needed). |
| `settings` | Non-secret JSON settings, recorded in binding manifests. |
| `credentials` | Credential references (`credentialRef("QUEUE_URL")`), recorded by name only. |
| `open(context)` | Connects and returns a `ProviderInstance`. |

`validateProvider(value)` checks a declaration without opening it and returns every problem: `HOLQA_BINDING_CONTRACT_INCOMPATIBLE` for a protocol or contract version, an unknown contract, kind or service; `HOLQA_BINDING_CONFIG_INVALID` for everything else (identifiers, role, missing or extra contracts, malformed capabilities, object events without `bucket.events`, a platform that lacks a mandatory contract or a resource kind, malformed emulations, topology, settings or credentials).

The provider type records what it binds: `BindingProvider<"queue">` has a required `resources.queue`, so it cannot be used where `BindingProvider<"bucket">` is expected. `AnyBindingProvider` accepts every provider.

### Opening

`open(context)` receives:

| Field | Meaning |
| --- | --- |
| `app` | The application descriptor. |
| `environment` | The binding configuration's name, for example `local` or `production`. |
| `resources` | The resources this provider was selected for, sorted by identifier. |
| `credential(reference)` | Resolves a credential reference through the configuration service; fails with `HOLQA_BINDING_CREDENTIALS_MISSING`. |
| `signal` | Aborted when the start exceeded its time limit or the runtime is stopping. |
| `log(level, message, fields?)` | Structured logs attributed to the provider, redacted like every runtime log. |

The returned `ProviderInstance` may contain `drivers`, `sources`, `config`, `telemetry`, `idempotency`, `operationBudgets`, and the lifecycle hooks `ready`, `health` and `stop`. Parts for contracts the provider did not declare are ignored.

## Binding configurations

A binding configuration selects a provider for every resource and service of an application in one environment. It is a module, conventionally `bindings.ts` next to `infra.ts`:

```ts
import { defineBindings, environmentConfig } from "@holqa/bindings";
import app from "./infra";

export default defineBindings(app, {
  name: "production",
  defaults: platformProvider,            // a platform provider
  kinds: { queue: brokerQueues },        // every queue
  resources: { "audit-log": auditQueue }, // one resource, by identifier
  services: { config: [secretFiles, environmentConfig()], telemetry: collector }
});
```

`platformProvider`, `brokerQueues`, `auditQueue`, `secretFiles` and `collector` stand for provider objects created by provider factories.

`defineBindings` is pure and type-checked against the application: a resource identifier or kind the application does not declare, a provider that does not bind a resource's kind, a service provider that does not supply the service, and (without `defaults`) a resource no entry covers are compile errors. Malformed settings fail at run time with `HOLQA_BINDING_CONFIG_INVALID`.

### Resolution

`resolveBindings(definition)` returns the selections and every problem, without opening anything:

| Rule | Behaviour |
| --- | --- |
| Resource precedence | Its `resources` entry, else its kind's `kinds` entry, else `defaults`. Each selection records its `source`: `resource`, `kind` or `default`. |
| No fall-through | A selected provider that does not bind the resource's kind is `HOLQA_BINDING_KIND_MISMATCH`; the next level is never tried. |
| Unknown entries | A `resources` entry for an undeclared identifier, or a `kinds` entry for a kind the application does not declare, is `HOLQA_BINDING_RESOURCE_UNKNOWN`. A `kinds` key that is not a resource kind is `HOLQA_BINDING_CONFIG_INVALID`. |
| Missing | A resource without a provider is `HOLQA_BINDING_MISSING`. |
| Providers | Every selected provider is validated (`validateProvider`). Two different providers may not share a name (`HOLQA_BINDING_CONFIG_INVALID`). |
| Services | `services.config`: ordered sources, the first with a value wins. `services.telemetry`: every listed provider receives every export. `idempotency`, `operation-budgets`: one provider. Without an entry, `defaults` when it supplies the service (`source: "default"`); for `config` only, `environmentConfig()` as the built-in fallback (`source: "builtin"`). A provider that does not supply the service is `HOLQA_BINDING_KIND_MISMATCH`. |
| Determinism | Selections are sorted by resource identifier; providers are listed in opening order (configuration, other services, resources); equal input gives equal output. |

`assertResolved(resolved)` throws the resolution's errors.

### Composition

`createBinding(resolved)` composes a valid resolution into one `RuntimeBinding`:

| Part | Behaviour |
| --- | --- |
| Drivers and sources | Dispatch to the provider selected for each resource. Source dispatchers exist for kinds whose selected providers deliver events (`topology.delivery` other than `none`). |
| `describe(resource)` | The selected provider's name and capabilities, so `bindApp` and `checkTriggerDelivery` check each resource against it. |
| `config(entry)` | The validated value, from the configuration sources in order. |
| `telemetry` | One forwarding exporter per telemetry provider. Batches recorded before the binding started are dropped. |
| `idempotency`, `operationBudgets` | Forward to the selected provider. |
| `lifecycle.start` | Opens every provider once: configuration providers first (they cannot use credential references), then other services, then resource providers. Resolves credentials through the configuration sources, checks that every provider supplied the parts it declares, then validates every configuration entry (`resolveConfiguration`). On failure, stops the providers already opened in reverse order and rejects with the classified failure; nothing falls back to another provider. |
| `lifecycle.ready`, `health`, `stop` | Forwarded to every provider; `stop` runs in reverse opening order, logs failures and continues. |

Drivers, sources and configuration used before `start` completes fail with `HOLQA_RUNTIME_NOT_RUNNING`. A composed binding starts once.

## Lifecycle

| Step | Who | What |
| --- | --- | --- |
| 1. Resolve configuration | Binding configuration | Select a provider for every resource and service. |
| 2. Validate | Tools and runtime | Contracts, capabilities and topology, without connecting. |
| 3. Acquire credentials | Provider (`open`) | Resolve credential references. |
| 4. Initialize | Provider (`open`, `BindingLifecycle.start`) | Open connections, create drivers and sources. |
| 5. Register | Runtime | Consume sources: one delivery worker per queue consumer and object event subscription, one subscription per schedule. |
| 6. Verify readiness | Provider (`ready`) | Resolve once operations and delivery work. |
| 7. Execute | Runtime | Invocations through the shared dispatcher. |
| 8. Monitor | Provider (`health`) | Report `healthy`, `degraded` or `unhealthy`; `combineHealth` reports the worst. |
| 9. Drain | Runtime | Stop receiving, let in-flight invocations finish within the grace period, cancel the rest and release their deliveries. |
| 10. Dispose | Provider (`stop`) | Close connections, timers and subscriptions. Must be safe after a failed or partial start. |

A provider never registers consumers itself and never falls back to another provider when it fails.

## Failures

`bindingFailure(kind, { binding, message, hint?, details? })` builds a classified diagnostic. Its `details` always contain `binding`, `failure` and `transient`.

| Kind | Code | Transient | Example |
| --- | --- | --- | --- |
| `configuration` | `HOLQA_BINDING_CONFIG_INVALID` | No | A malformed setting or provider declaration. |
| `credentials-missing` | `HOLQA_BINDING_CREDENTIALS_MISSING` | No | `QUEUE_URL` is not set. |
| `credentials-invalid` | `HOLQA_BINDING_CREDENTIALS_INVALID` | No | The broker rejected the login. |
| `capability` | `HOLQA_BINDING_CAPABILITY_UNSUPPORTED` | No | A queue requires a dead-letter destination the provider cannot keep. |
| `version` | `HOLQA_BINDING_CONTRACT_INCOMPATIBLE` | No | A provider built for another contract version. |
| `unavailable` | `HOLQA_BINDING_UNAVAILABLE` | Yes | The broker refuses connections. |
| `failed` | `HOLQA_BINDING_FAILED` | No | The bucket does not exist. |

`isTransientBindingFailure(diagnostic)` is `true` only for `HOLQA_BINDING_UNAVAILABLE`. Messages and details never contain credential values.

## Capabilities

A resource declares requirements (`ResourceKindMap[kind]["requirements"]`); a provider advertises capabilities per resource kind (`ResourceKindMap[kind]["capabilities"]`). Both sides are named in the required-capability vocabulary of the [compiler specification](compiler-specification.md#required-capabilities):

| Function | Returns |
| --- | --- |
| `requiredCapabilities(resource)` | What a resource requires, for example `["queue", "queue.delivery.at-least-once", "queue.dead-letter"]`. The compiler records the same strings in manifests. |
| `providedCapabilities(kind, capabilities)` | What a provider advertises for a kind, sorted, for example `queue.delay` when it can delay deliveries, `bucket.signed-urls`, `trigger.bucket.object-created`. |

Quantities are part of the advertised capabilities and are checked where they apply:

| Capability | Checked |
| --- | --- |
| `queue.maxAttempts`, `queue.maxDelaySeconds` | Against declared `maxAttempts` and backoff (`checkCapabilities`), the default backoff (`checkTriggerDelivery`), and each send's delay (`HOLQA_BINDING_CAPABILITY_UNSUPPORTED`). |
| `queue.maxMessageBytes` | Each send: the serialized `holqa.message/1` envelope (UTF-8 JSON) must not be larger. Absent means no limit. |
| `bucket.signedUrls.maxExpiresInSeconds` | Each signed URL request. |
| `execution.maxTimeoutMs`, `execution.maxConcurrency` | The runtime's limits (`validateBindings`). |

Sends and signed URLs use the limits of the provider selected for the resource (`resourceBindingInfo`), never those of another provider in the same binding.

`checkCapabilities(resource, capabilities, bindingName)` reports one `HOLQA_BINDING_CAPABILITY_UNSUPPORTED` per unmet requirement, with `details`:

| Key | Meaning |
| --- | --- |
| `resource` | The resource identifier. |
| `kind` | Its kind. |
| `binding` | The provider (or binding) selected for it. |
| `requirement` | The unmet capability in the vocabulary, plus `queue.delay` for redelivery delays longer than the provider supports. A kind the provider does not bind at all reports the kind itself. |

A stronger capability than required is accepted. A requirement is never weakened. When a binding `describe`s resources individually (`RuntimeBinding.describe`), `bindApp` and `checkTriggerDelivery` compare each resource with the provider selected for it (`resourceBindingInfo`), and trigger delivery diagnostics name it in `details.binding`, with `details.requirement` set to `trigger.<trigger kind>`.

### Native and emulated capabilities

A provider may meet a capability its infrastructure lacks through a compatibility layer, only when its settings enable it explicitly, and it must declare it in `emulations` with the mechanism and the infrastructure it needs. Inspection marks such requirements `emulated`, so the operational consequences stay visible.

### Validation

`validateBindings(resolved, { handlers?, limits?, operationBudgets? })` (`@holqa/bindings`) checks a resolved configuration without opening anything:

| Check | Diagnostic |
| --- | --- |
| The resolution's own problems (missing, unknown, mismatched, invalid providers); further checks are skipped when there are any. | As reported by `resolveBindings`. |
| Every resource's requirements against its provider. | `HOLQA_BINDING_CAPABILITY_UNSUPPORTED` |
| Every handler's trigger can be delivered (`checkTriggerDelivery`). | `HOLQA_BINDING_CAPABILITY_UNSUPPORTED` |
| A background handler whose resource's provider delivers no events (`topology.delivery: "none"`), or a pull-based provider when the execution host is `request-driven`. | `HOLQA_BINDING_TOPOLOGY_UNSUPPORTED` |
| `limits.timeoutMs` (30 000 when not set) and `limits.concurrency` within the execution host's `maxTimeoutMs` and `maxConcurrency`. | `HOLQA_BINDING_CAPABILITY_UNSUPPORTED` (`requirement`: `execution.timeout`, `execution.concurrency`) |
| An idempotency service when a handler declares `idempotency`; an operation budget service when `operationBudgets` is set. | `HOLQA_BINDING_CAPABILITY_UNSUPPORTED` (`requirement`: `idempotency`, `operation-budgets`) |

`inspectBindings(resolved, options)` returns the `holqa.bindings/1` report, plain JSON without credential values:

| Field | Content |
| --- | --- |
| `name`, `application` | The configuration and application names. |
| `resources` | Per resource, sorted: `id`, `kind`, `provider`, `selection` (`resource`, `kind`, `default`) and `requirements`, each `{ capability, support }` with `support` `native`, `emulated` or `unsupported`; with handlers, also `trigger.<kind>`. |
| `services` | Per service: `providers` and `selection` (`service`, `default`, `builtin`). |
| `providers` | Per provider, in opening order: `name`, `provider`, `role`, `contracts`, `capabilities` (provided vocabulary per kind), `limits` (advertised capabilities as declared), `services`, `emulations`, `topology`, `execution`, `settings`, `credentials` (names). |
| `diagnostics` | What `validateBindings` reported. |

`holqa bindings inspect`, `holqa bindings validate` and `holqa inspect --capabilities` print them ([CLI reference](cli.md#holqa-bindings-inspect-and-holqa-bindings-validate)).

## Related

- [ADR 0029: A binding provider protocol with versioned contracts](../architecture/decisions/0029-binding-provider-protocol-and-versioned-contracts.md)
- [ADR 0030: Binding composition with deterministic resolution](../architecture/decisions/0030-binding-composition-and-resolution.md)
- [Infrastructure providers](../concepts/infrastructure-providers.md)
- [Runtime reference](runtime.md)
- [Local environment reference](local.md)
- [Diagnostic codes](diagnostic-codes.md)
