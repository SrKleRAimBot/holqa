import type {
  BindingStopOptions,
  ComponentHealth
} from "@/binding/lifecycle";
import type {
  CredentialReference,
  ProviderContext
} from "@/binding/provider";
import type { DeliverySource } from "@/binding/sources";
import type { JsonObject } from "@/json";

// Object storage and its event notifications are often separate
// infrastructure: an S3-compatible store publishes notifications to a message
// broker, a webhook or a cloud queue. An event channel is the part that
// carries raw notifications, so a storage provider can deliver object events
// from any channel without depending on it.

/**
 * An opened event channel: raw notification bodies per subscription, as
 * leased deliveries with the usual settlement semantics.
 */
export interface OpenedEventChannel {
  /**
   * Attaches to the notifications of one subscription (one handler). The
   * subscription's infrastructure (for example a queue bound to the store's
   * notification exchange) is created by provisioning; attaching must fail with
   * a classified binding failure when it is missing, never create it.
   */
  readonly subscribe: (subscription: string) => Promise<DeliverySource<Uint8Array>>;
  readonly health?: () => Promise<Omit<ComponentHealth, "name">>;
  readonly stop?: (options: BindingStopOptions) => Promise<void>;
}

/**
 * Where a storage provider receives notifications from. Like a provider, it
 * is side-effect-free data plus `open`; the storage provider that uses it
 * opens and stops it and lists its credentials and settings as its own.
 */
export interface EventChannel {
  /** The channel implementation's namespaced identifier, for example `holqa.rabbitmq.events`. */
  readonly channel: string;
  /** A short description for inspection, for example `RabbitMQ queues bound to the notification exchange`. */
  readonly description: string;
  readonly settings?: JsonObject;
  readonly credentials?: readonly CredentialReference[];
  readonly open: (context: ProviderContext) => Promise<OpenedEventChannel>;
}