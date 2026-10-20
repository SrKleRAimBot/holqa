import type {
  BindingProvider,
  BindingStopOptions,
  BucketCapabilities,
  BucketDriver,
  CredentialReference,
  EventChannel,
  JsonObject,
  ObjectEventSource,
  ObjectEventSubscription,
  ObjectEventType,
  OpenedEventChannel,
  ProviderContext,
  ProviderInstance,
  ResourceDescriptorOf
} from "@holqa/core";

import type { S3Connection } from "@/client";

import {
  bindingFailure,
  bindingProtocolVersion,
  HolqaError,
  isCredentialReference
} from "@holqa/core";

import {
  deleteObject,
  getObject,
  headBucket,
  headObject,
  listObjects,
  putObject,
  signObjectUrl
} from "@/client";
import { objectEventSource } from "@/events";
import { provisioner } from "@/provisioner";

/** Object events delivered through a separate event channel. */
export interface S3EventsOptions {
  /** Where the store's notifications arrive, for example `rabbitmq.eventChannel(...)`. */
  readonly channel: EventChannel;
  /** The event types the store is configured to publish. Default both. */
  readonly types?: readonly ObjectEventType[];
}

/** Settings of {@link s3.buckets}. */
export interface S3BucketsOptions {
  /** The service's base URL, for example `https://s3.eu-central-1.amazonaws.com` or `http://minio:9000`. */
  readonly endpoint: string;
  /** The signing region. Default `us-east-1`. */
  readonly region?: string;
  /** Address buckets as `<endpoint>/<bucket>` (default, works with most S3-compatible stores) or as `<bucket>.<host>`. */
  readonly forcePathStyle?: boolean;
  readonly accessKeyId: CredentialReference;
  readonly secretAccessKey: CredentialReference;
  /** For temporary credentials. */
  readonly sessionToken?: CredentialReference;
  /** The provider's name. Default `s3`. */
  readonly name?: string;
  /** Store bucket names by Holqa bucket identifier. Buckets not listed use `<prefix><identifier>`. */
  readonly buckets?: Readonly<Record<string, string>>;
  readonly prefix?: string;
  /**
   * Declares that the store's bucket policies allow anonymous reads, so
   * `public-read` buckets can be bound. The provider cannot verify policies;
   * it never changes them.
   */
  readonly publicRead?: boolean;
  /** Whether presigned URLs are issued. Default `true` (at most 7 days). */
  readonly signedUrls?: boolean;
  /** Object events, delivered by a channel. Absent: the provider delivers no events. */
  readonly events?: S3EventsOptions;
  /** The time limit of one request, in milliseconds. Default 30 000. */
  readonly timeoutMs?: number;
  /** The Fetch implementation; replaceable in tests. */
  readonly fetch?: (request: Request) => Promise<Response>;
}

/** Matches a bucket name the S3 naming rules allow. */
const bucketNamePattern = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

/**
 * Validates the settings.
 *
 * @param options - The untrusted settings.
 * @param name - The provider's name.
 * @throws {HolqaError} `HOLQA_BINDING_CONFIG_INVALID`, one diagnostic per problem.
 */
function checkOptions(options: S3BucketsOptions, name: string): void {
  const problems: string[] = [];
  if (typeof options.endpoint !== "string" || !URL.canParse(options.endpoint) || !/^https?:$/.test(new URL(options.endpoint).protocol))
    problems.push("\"endpoint\" must be an absolute http or https URL.");
  else if (new URL(options.endpoint).username !== "" || new URL(options.endpoint).password !== "")
    problems.push("\"endpoint\" must not contain credentials; use accessKeyId and secretAccessKey references.");
  for (const field of ["accessKeyId", "secretAccessKey"] as const) {
    if (!isCredentialReference(options[field]))
      problems.push(`"${field}" must be a credential reference, for example credentialRef("S3_${field === "accessKeyId" ? "ACCESS_KEY_ID" : "SECRET_ACCESS_KEY"}").`);
  }
  if (options.sessionToken !== undefined && !isCredentialReference(options.sessionToken))
    problems.push("\"sessionToken\" must be a credential reference.");
  if (options.region !== undefined && !(typeof options.region === "string" && /^[\w-]{1,40}$/.test(options.region)))
    problems.push("\"region\" must be a region name such as \"eu-central-1\".");
  for (const [id, bucket] of Object.entries(options.buckets ?? {})) {
    if (typeof bucket !== "string" || !bucketNamePattern.test(bucket))
      problems.push(`"buckets.${id}" must be a valid bucket name (3 to 63 lowercase letters, digits, dots and hyphens).`);
  }
  if (options.timeoutMs !== undefined && !(Number.isSafeInteger(options.timeoutMs) && options.timeoutMs >= 1))
    problems.push("\"timeoutMs\" must be a whole number of at least 1.");
  const types = options.events?.types;
  if (types !== undefined && !(Array.isArray(types) && types.length > 0 && types.every(type => type === "object.created" || type === "object.deleted")))
    problems.push("\"events.types\" must list \"object.created\" and/or \"object.deleted\".");
  if (options.events !== undefined && (typeof options.events.channel?.open !== "function" || typeof options.events.channel.channel !== "string"))
    problems.push("\"events.channel\" must be an event channel, for example rabbitmq.eventChannel(...).");
  if (problems.length > 0)
    throw new HolqaError(problems.map(problem => bindingFailure("configuration", { binding: name, message: `s3.buckets: ${problem}` })));
}

/**
 * Creates an S3-compatible bucket provider: object writes, reads, metadata,
 * deletion, paged listing and presigned URLs, signed with AWS Signature
 * Version 4 over `fetch`, for AWS S3, MinIO, Ceph, R2 and other compatible
 * stores.
 *
 * It needs only data-plane permissions on the configured buckets
 * (`HeadBucket`, `GetObject`, `PutObject`, `DeleteObject`, `ListBucket`). It
 * never creates buckets, changes policies or configures notifications.
 * Object events are a separate concern: they need a store configured to
 * publish notifications and an event channel that carries them
 * (`events.channel`); without one, the provider advertises no events and
 * handlers of object events fail validation.
 *
 * @example
 * ```ts
 * s3.buckets({ endpoint: "http://minio:9000", accessKeyId: credentialRef("S3_ACCESS_KEY_ID"), secretAccessKey: credentialRef("S3_SECRET_ACCESS_KEY") });
 * ```
 *
 * @param options - Endpoint, credentials, bucket names, events and limits.
 * @returns A resource provider for buckets.
 * @throws {HolqaError} `HOLQA_BINDING_CONFIG_INVALID` for invalid settings.
 */
function buckets(options: S3BucketsOptions): BindingProvider<"bucket"> {
  const name = options.name ?? "s3";
  checkOptions(options, name);
  const events = options.events;
  const eventTypes = events?.types ?? ["object.created", "object.deleted"];
  const capabilities: BucketCapabilities = Object.freeze({
    access: Object.freeze(options.publicRead === true ? ["private" as const, "public-read" as const] : ["private" as const]),
    ...options.signedUrls === false ? {} : { signedUrls: Object.freeze({ maxExpiresInSeconds: 604_800 }) },
    ...events === undefined ? {} : { events: Object.freeze([...eventTypes]) }
  });
  /**
   * Names the store bucket of a Holqa bucket.
   *
   * @param id - The Holqa bucket identifier.
   * @returns The store's bucket name.
   */
  const bucketName = (id: string): string => options.buckets?.[id] ?? `${options.prefix ?? ""}${id}`;
  const credentials = [options.accessKeyId, options.secretAccessKey, ...options.sessionToken === undefined ? [] : [options.sessionToken], ...events?.channel.credentials ?? []];
  const settings: JsonObject = Object.freeze({
    endpoint: options.endpoint,
    region: options.region ?? "us-east-1",
    forcePathStyle: options.forcePathStyle ?? true,
    publicRead: options.publicRead === true,
    ...options.prefix === undefined ? {} : { prefix: options.prefix },
    ...options.buckets === undefined ? {} : { buckets: Object.freeze({ ...options.buckets }) },
    ...events === undefined ? {} : { events: Object.freeze({ channel: events.channel.channel, types: Object.freeze([...eventTypes]), ...events.channel.settings === undefined ? {} : { channelSettings: events.channel.settings } }) }
  });

  return Object.freeze({
    bindingProtocol: bindingProtocolVersion,
    provider: "holqa.s3",
    name,
    role: "resource",
    contracts: Object.freeze(events === undefined ? { bucket: 1 } : { "bucket": 1, "bucket.events": 1 }),
    resources: Object.freeze({ bucket: capabilities }),
    services: Object.freeze({}),
    topology: Object.freeze(events === undefined
      ? { delivery: "none", state: "shared" }
      : { delivery: "pull", state: "shared", connectors: Object.freeze([`object storage configured to publish notifications for create and delete to ${events.channel.description}`, "a long-running application process (or worker) that consumes the event channel"]) }),
    settings,
    credentials: Object.freeze(credentials),
    /**
     * Resolves credentials, checks every bucket and opens the event channel.
     *
     * @param context - The provider context.
     * @returns The instance with drivers, sources and lifecycle hooks.
     */
    open: async (context: ProviderContext): Promise<ProviderInstance> => {
      const connection: S3Connection = Object.freeze({
        endpoint: new URL(options.endpoint),
        region: options.region ?? "us-east-1",
        forcePathStyle: options.forcePathStyle ?? true,
        credentials: Object.freeze({
          accessKeyId: context.credential(options.accessKeyId),
          secretAccessKey: context.credential(options.secretAccessKey),
          ...options.sessionToken === undefined ? {} : { sessionToken: context.credential(options.sessionToken) }
        }),
        binding: name,
        timeoutMs: options.timeoutMs ?? 30_000,
        ...options.fetch === undefined ? {} : { fetch: options.fetch }
      });
      for (const resource of context.resources) {
        if (resource.kind === "bucket")
          await headBucket(connection, bucketName(resource.id));
      }
      const channel: OpenedEventChannel | undefined = events === undefined ? undefined : await events.channel.open(context);
      return Object.freeze({
        drivers: Object.freeze({
          bucket: (resource: ResourceDescriptorOf<"bucket">): BucketDriver => {
            const bucket = bucketName(resource.id);
            return Object.freeze<BucketDriver>({
              put: (key, body, putOptions, operation) => putObject(connection, bucket, key, body, putOptions.contentType, operation?.trace),
              get: key => getObject(connection, bucket, key),
              head: key => headObject(connection, bucket, key),
              delete: key => deleteObject(connection, bucket, key),
              list: listOptions => listObjects(connection, bucket, { ...listOptions.prefix === undefined ? {} : { prefix: listOptions.prefix }, ...listOptions.cursor === undefined ? {} : { cursor: listOptions.cursor }, limit: listOptions.limit ?? 100 }),
              signUrl: async (key, urlOptions) => {
                if (options.signedUrls === false)
                  throw new HolqaError(bindingFailure("capability", { binding: name, message: "This provider issues no signed URLs." }));
                return signObjectUrl(connection, bucket, key, urlOptions);
              }
            });
          }
        }),
        ...channel === undefined
          ? {}
          : {
            sources: Object.freeze({
              bucket: (resource: ResourceDescriptorOf<"bucket">): ObjectEventSource => Object.freeze({
                subscribe: async (subscription: ObjectEventSubscription) => objectEventSource(await channel.subscribe(`${resource.id}.${subscription.id}`), subscription, resource.id, bucketName(resource.id))
              })
            })
          },
        health: async () => channel?.health === undefined ? { status: "healthy" as const } : channel.health(),
        stop: async (stopOptions: BindingStopOptions) => {
          await channel?.stop?.(stopOptions);
        }
      });
    }
  });
}

/** S3-compatible binding providers. */
export const s3 = Object.freeze({ buckets, provisioner });