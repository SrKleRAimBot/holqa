import type { BindingSlot } from "@/binding";
import type {
  JsonObject,
  JsonValue
} from "@/json";
import type { StandardSchemaV1 } from "@/standard-schema";

/**
 * The property under which every Holqa value carries its descriptor. A string
 * key (like Standard Schema's `~standard`) instead of a `unique symbol` keeps
 * values compatible across duplicate copies of the package.
 */
export const descriptorKey = "~holqa";

/** The descriptor protocol version. Consumers reject descriptors with a version they do not understand. */
export const descriptorProtocol = 1;

/**
 * A logical resource declaration as plain data. `config` holds the
 * JSON-serializable options (delivery policy, cron expression, ...); `schemas`
 * holds the Standard Schemas the resource declares (for example `message`).
 */
export interface ResourceDescriptor {
  readonly protocol: typeof descriptorProtocol;
  readonly type: "resource";
  readonly kind: string;
  readonly id: string;
  readonly config: JsonObject;
  readonly schemas: Readonly<Record<string, StandardSchemaV1>>;
}

/** What invokes a handler: a trigger kind and the identifier of the resource it belongs to. */
export interface TriggerDescriptor extends JsonObject {
  readonly kind: string;
  readonly resource: string;
}

/** Structured logging available to a running handler. */
export interface InvocationLogger {
  readonly info: (message: string, fields?: JsonObject) => void;
  readonly warn: (message: string, fields?: JsonObject) => void;
  readonly error: (message: string, fields?: JsonObject) => void;
}

/** What a runtime passes to a handler descriptor's `invoke` for one invocation. */
export interface InvocationContext {
  readonly invocationId: string;
  /** Aborted when the invocation is cancelled, times out, or the runtime is disposed. */
  readonly signal: AbortSignal;
  /** Trigger metadata such as the delivery attempt or the scheduled time. */
  readonly metadata: JsonObject;
  readonly log: InvocationLogger;
}

/**
 * A registered handler as plain data plus one function. The runtime calls
 * `invoke` with untrusted input; `invoke` validates it against `schemas` before
 * running user code.
 */
export interface HandlerDescriptor {
  readonly protocol: typeof descriptorProtocol;
  readonly type: "handler";
  readonly id: string;
  readonly trigger: TriggerDescriptor;
  readonly config: JsonObject;
  readonly schemas: Readonly<Record<string, StandardSchemaV1>>;
  readonly invoke: (input: unknown, context: InvocationContext) => Promise<unknown>;
}

/** A configuration entry: a secret or a non-sensitive variable with its schema. */
export interface ConfigDescriptor {
  readonly protocol: typeof descriptorProtocol;
  readonly type: "config";
  readonly name: string;
  readonly sensitive: boolean;
  readonly schema: StandardSchemaV1;
  readonly defaultValue?: JsonValue;
}

/** An application: its resources, configuration, handler globs and runtime binding slot. */
export interface AppDescriptor {
  readonly protocol: typeof descriptorProtocol;
  readonly type: "app";
  readonly name: string;
  readonly handlers: readonly string[];
  readonly resources: readonly ResourceDescriptor[];
  readonly config: readonly ConfigDescriptor[];
  readonly binding: BindingSlot;
}

/** The `type` values of the descriptor kinds this protocol version defines. */
const descriptorTypes: ReadonlySet<unknown> = new Set(["resource", "handler", "config", "app"]);

/** Any Holqa descriptor. */
export type Descriptor = ResourceDescriptor | HandlerDescriptor | ConfigDescriptor | AppDescriptor;

/** A value that carries a Holqa descriptor. */
export interface Described<D extends Descriptor = Descriptor> {
  readonly [descriptorKey]: D;
}

/**
 * Reads the descriptor of a value without trusting its type.
 *
 * @param value - Any value, for example a module export.
 * @returns The descriptor, or `undefined` when the value is not a Holqa value
 * or uses an unknown protocol version.
 */
export function getDescriptor(value: unknown): Descriptor | undefined {
  if ((typeof value !== "object" && typeof value !== "function") || value === null || !(descriptorKey in value))
    return undefined;
  const descriptor: unknown = value[descriptorKey];
  if (typeof descriptor !== "object" || descriptor === null || !("protocol" in descriptor) || !("type" in descriptor))
    return undefined;
  if (descriptor.protocol !== descriptorProtocol)
    return undefined;
  return descriptorTypes.has(descriptor.type) ? descriptor as Descriptor : undefined;
}

/**
 * Reads a handler descriptor from a value, such as a handler module's export.
 *
 * @param value - Any value.
 * @returns The handler descriptor, or `undefined` when the value is not a handler.
 */
export function getHandlerDescriptor(value: unknown): HandlerDescriptor | undefined {
  const descriptor = getDescriptor(value);
  return descriptor?.type === "handler" ? descriptor : undefined;
}

/**
 * Reads an application descriptor from a value, such as `infra.ts`'s default export.
 *
 * @param value - Any value.
 * @returns The application descriptor, or `undefined` when the value is not an application.
 */
export function getAppDescriptor(value: unknown): AppDescriptor | undefined {
  const descriptor = getDescriptor(value);
  return descriptor?.type === "app" ? descriptor : undefined;
}