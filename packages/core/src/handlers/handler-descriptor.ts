import type { InvocationLineage } from "@/binding/trace";
import type { ApplicationScope } from "@/handlers/application-scope";
import type {
  HandlerEventPolicy,
  HandlerIdempotencyPolicy
} from "@/handlers/event-policy";
import type {
  TriggerKind,
  TriggerKindMap
} from "@/handlers/triggers";
import type { ResourceId } from "@/identity/resource-id";
import type {
  EmptyObject,
  JsonObject
} from "@/json";
import type { DescriptorProtocol } from "@/protocol/version";
import type { ResourceReference } from "@/resources/resource-descriptor";

/**
 * What invokes a handler: the trigger kind, the resource it belongs to and the
 * trigger's options. Plain JSON data.
 *
 * @typeParam Trigger - The trigger kind.
 */
export interface TriggerOf<Trigger extends TriggerKind> {
  readonly kind: Trigger;
  readonly resource: ResourceReference<TriggerKindMap[Trigger]["resource"]>;
  readonly options: TriggerKindMap[Trigger]["options"];
}

/** Any trigger, discriminated by `kind`. */
export type Trigger = { [Kind in TriggerKind]: TriggerOf<Kind> }[TriggerKind];

/**
 * A handler's declarative metadata: its stable identity and its trigger. This
 * part is JSON data that tools inspect without ever calling user code.
 *
 * @typeParam Trigger - The trigger kind.
 */
export interface HandlerDefinitionOf<Trigger extends TriggerKind> {
  /** The handler's persistent logical identity (resource identifier grammar). */
  readonly id: ResourceId;
  readonly trigger: TriggerOf<Trigger>;
  /** Event safety declarations: publication targets static analysis cannot see, an intentional cycle, and limits. Absent means none. */
  readonly events?: HandlerEventPolicy;
  /** Duplicate suppression for queue consumers and object event handlers. Absent means none. */
  readonly idempotency?: HandlerIdempotencyPolicy;
}

/** Any handler definition, discriminated by `trigger.kind`. */
export type HandlerDefinition = { [Kind in TriggerKind]: HandlerDefinitionOf<Kind> }[TriggerKind];

/** Structured logging available to a running handler. */
export interface InvocationLogger {
  readonly info: (message: string, fields?: JsonObject) => void;
  readonly warn: (message: string, fields?: JsonObject) => void;
  readonly error: (message: string, fields?: JsonObject) => void;
}

/**
 * What a runtime passes to a handler's `invoke` for one invocation.
 *
 * @typeParam Metadata - Trusted, trigger-specific runtime data such as the delivery attempt.
 */
export interface InvocationContext<Metadata = EmptyObject> {
  /** Unique per invocation. */
  readonly invocationId: string;
  /**
   * Groups related invocations, for example every invocation caused by one
   * incoming request. Runtimes set it from a trusted caller or default it to
   * `invocationId`. Absent when the caller provides none.
   */
  readonly correlationId?: string;
  /**
   * The invocation's event lineage: its root operation, what caused it and
   * its depth. Runtimes that track lineage set it; absent otherwise, for
   * example when a test calls `invoke` directly.
   */
  readonly lineage?: InvocationLineage;
  /** Aborted when the invocation is cancelled, times out, or the runtime shuts down. */
  readonly signal: AbortSignal;
  readonly metadata: Metadata;
  readonly log: InvocationLogger;
  /** The application execution context. Absent outside a runtime, for example when a test calls `invoke` directly. */
  readonly scope?: ApplicationScope;
}

/**
 * The executable part of a handler. A runtime calls it with untrusted input;
 * it validates that input against the handler's schemas before running user code.
 *
 * @typeParam Trigger - The trigger kind, which fixes the metadata type.
 */
export type HandlerInvoke<Trigger extends TriggerKind> = (input: unknown, context: InvocationContext<TriggerKindMap[Trigger]["metadata"]>) => Promise<unknown>;

/**
 * A registered handler: declarative metadata (`definition`) and schemas that a
 * compiler can inspect, kept apart from the executable `invoke` function that
 * only a runtime calls.
 *
 * @typeParam Trigger - The trigger kind.
 */
export interface HandlerDescriptorOf<Trigger extends TriggerKind> {
  readonly protocol: DescriptorProtocol;
  readonly type: "handler";
  readonly definition: HandlerDefinitionOf<Trigger>;
  readonly schemas: TriggerKindMap[Trigger]["schemas"];
  readonly invoke: HandlerInvoke<Trigger>;
}

/** Any handler descriptor, discriminated by `definition.trigger.kind`. */
export type HandlerDescriptor = { [Kind in TriggerKind]: HandlerDescriptorOf<Kind> }[TriggerKind];