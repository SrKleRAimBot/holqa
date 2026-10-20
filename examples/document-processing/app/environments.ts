import type {
  BindingsDefinition,
  ProvisioningDefinition
} from "@holqa/bindings";

import {
  defineBindings,
  defineProvisioning,
  environmentConfig
} from "@holqa/bindings";
import { container } from "@holqa/container";
import { credentialRef } from "@holqa/core";
import { localEnvironment } from "@holqa/local";
import { otlp } from "@holqa/opentelemetry";
import { rabbitmq } from "@holqa/rabbitmq";
import { s3 } from "@holqa/s3";
import app from "@/app/infra";

// The same application, bound three ways. Nothing here changes a handler:
// switching environments only selects other providers. Provider-specific
// settings (endpoints, names, credentials) live here, never in handlers.

/** Where the external infrastructure is. Non-secret: credentials are references, resolved when the application starts. */
export interface ExternalSettings {
  /** The S3-compatible store's base URL. */
  readonly s3Endpoint: string;
  /** The OTLP/HTTP receiver's base URL. */
  readonly otlpEndpoint: string;
  /** Prepended to broker queue and bucket names, to share infrastructure between deployments or test runs. Default empty. */
  readonly prefix?: string;
}

/** The infrastructure of the Docker Compose demonstration (`compose.yaml`), by service name. */
export const composeSettings: ExternalSettings = { s3Endpoint: "http://object-store:9000", otlpEndpoint: "http://collector:4318" };

/**
 * Environment A: everything local, without credentials or external
 * services. Used by `holqa dev --bindings app/bindings.ts` and by the tests.
 *
 * @returns The binding configuration.
 */
export function localBindings(): BindingsDefinition<typeof app> {
  return defineBindings(app, { name: "local", defaults: localEnvironment().platform() });
}

/**
 * The storage provider of the external environments: an S3-compatible
 * store whose bucket notifications arrive through RabbitMQ.
 *
 * @param settings - The endpoints and name prefix.
 * @returns The bucket provider.
 */
function storage(settings: ExternalSettings): ReturnType<typeof s3.buckets> {
  const prefix = settings.prefix ?? "";
  return s3.buckets({
    endpoint: settings.s3Endpoint,
    prefix,
    accessKeyId: credentialRef("S3_ACCESS_KEY_ID"),
    secretAccessKey: credentialRef("S3_SECRET_ACCESS_KEY"),
    events: { channel: rabbitmq.eventChannel({ url: credentialRef("QUEUE_URL"), queuePrefix: `holqa.events.${prefix}` }) }
  });
}

/**
 * The queue provider of the external environments.
 *
 * @param settings - The name prefix.
 * @returns The queue provider.
 */
function queues(settings: ExternalSettings): ReturnType<typeof rabbitmq.queues> {
  return rabbitmq.queues({ url: credentialRef("QUEUE_URL"), delayedDelivery: "delay-queues", prefix: settings.prefix ?? "" });
}

/**
 * Environment B: external infrastructure. The handlers run in a Bun
 * container (`container.host()`, packaged by `holqa package`); queues are
 * RabbitMQ queues; files are in an S3-compatible store whose notifications
 * reach the object event handlers through RabbitMQ; schedules run in the
 * container's process; configuration comes from the environment; telemetry
 * goes to an OTLP receiver.
 *
 * @param settings - The endpoints and name prefix.
 * @returns The binding configuration.
 */
export function externalBindings(settings: ExternalSettings = composeSettings): BindingsDefinition<typeof app> {
  const host = container.host();
  return defineBindings(app, {
    name: "external",
    kinds: { "http.api": host, "queue": queues(settings), "bucket": storage(settings), "schedule": container.schedules() },
    services: { config: environmentConfig(), telemetry: otlp.telemetry({ endpoint: settings.otlpEndpoint }) }
  });
}

/**
 * Environment C: mixed providers. Compute, HTTP and schedules stay on the
 * local platform; queues and files use RabbitMQ and the S3-compatible store;
 * telemetry goes to an independently configured OTLP receiver; credentials
 * come from mounted secret files first and the environment second.
 *
 * @param settings - The endpoints, name prefix and secrets directory.
 * @param settings.secretsDirectory - Where the secret files are mounted.
 * @param settings.stateDirectory - Where the local platform keeps its state. Default `.holqa/local`.
 * @returns The binding configuration.
 */
export function mixedBindings(settings: ExternalSettings & { readonly secretsDirectory: string; readonly stateDirectory?: string }): BindingsDefinition<typeof app> {
  return defineBindings(app, {
    name: "mixed",
    defaults: localEnvironment({ ...settings.stateDirectory === undefined ? {} : { directory: settings.stateDirectory }, telemetry: false }).platform(),
    kinds: { queue: queues(settings), bucket: storage(settings) },
    services: {
      config: [container.secretFiles({ directory: settings.secretsDirectory }), environmentConfig()],
      telemetry: otlp.telemetry({ endpoint: settings.otlpEndpoint })
    }
  });
}

/**
 * Provisions the external infrastructure of a binding configuration with
 * administrative credentials the application never receives: the RabbitMQ
 * queues, the notification exchange and subscription queues, the bucket,
 * and the bucket's notification rule to the store's AMQP target.
 *
 * @param bindings - The external or mixed binding configuration.
 * @param notificationTarget - The store's notification target for the RabbitMQ exchange, for example `arn:rustfs:sqs::primary:amqp`.
 * @param s3Endpoint - Where provisioning reaches the store, when it differs from the application's endpoint.
 * @returns The provisioning configuration.
 */
export function provisioningOf(bindings: BindingsDefinition<typeof app>, notificationTarget = "arn:rustfs:sqs::primary:amqp", s3Endpoint?: string): ProvisioningDefinition {
  return defineProvisioning(bindings, {
    provisioners: [
      rabbitmq.provisioner({ url: credentialRef("RABBITMQ_ADMIN_URL") }),
      s3.provisioner({ ...s3Endpoint === undefined ? {} : { endpoint: s3Endpoint }, accessKeyId: credentialRef("S3_ADMIN_ACCESS_KEY_ID"), secretAccessKey: credentialRef("S3_ADMIN_SECRET_ACCESS_KEY"), notifications: { target: notificationTarget } })
    ]
  });
}