import type {
  AnyBindingProvider,
  AppliedChange,
  CredentialReference,
  Diagnostic,
  JsonObject,
  PlannedChange,
  Provisioner,
  ProvisioningContext,
  ResourceDescriptor
} from "@holqa/core";

import type { S3Connection } from "@/client";

import {
  bindingFailure,
  createDiagnostic,
  diagnosticCodes,
  HolqaError,
  isCredentialReference,
  provisioningProtocolVersion
} from "@holqa/core";

import {
  bucketExists,
  createBucket,
  getBucketNotification,
  putBucketNotification
} from "@/client";

/** Settings of {@link s3.provisioner}. */
export interface S3ProvisionerOptions {
  /** An access key allowed to create buckets and configure notifications. The runtime never needs it. */
  readonly accessKeyId: CredentialReference;
  readonly secretAccessKey: CredentialReference;
  readonly sessionToken?: CredentialReference;
  /** The provisioner's name. Default `s3.provisioner`. */
  readonly name?: string;
  /** Only provision for the runtime providers with these names. Default every S3 provider. */
  readonly providers?: readonly string[];
  /**
   * Configure the store to publish object event notifications to this
   * target, for buckets whose provider delivers events. The target is the
   * store's identifier of a queue, broker or webhook it already knows, for
   * example `arn:minio:sqs::primary:amqp` or `arn:rustfs:sqs::primary:amqp`
   * for an AMQP target configured on a MinIO or RustFS server. Absent:
   * notifications are left to the operator, and the plan says so.
   */
  readonly notifications?: {
    readonly target: string;
    /** The identifier of the notification rule Holqa manages; other rules are kept. Default `holqa`. */
    readonly id?: string;
  };
  readonly timeoutMs?: number;
  /** The Fetch implementation; replaceable in tests. */
  readonly fetch?: (request: Request) => Promise<Response>;
}

/** The fields of the bucket provider's settings the provisioner reads. */
interface BucketSettings {
  readonly endpoint: string;
  readonly region?: string;
  readonly forcePathStyle?: boolean;
  readonly prefix?: string;
  readonly buckets?: Readonly<Record<string, string>>;
  readonly events?: { readonly types?: readonly string[] };
}

/** The S3 event names of each object event type. */
const eventNames = { "object.created": "s3:ObjectCreated:*", "object.deleted": "s3:ObjectRemoved:*" } as const;

/**
 * Escapes text for an XML element.
 *
 * @param text - Raw text.
 * @returns The escaped text.
 */
function escapeXml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/**
 * Splits a notification configuration into its rules, as XML fragments.
 *
 * @param xml - A `NotificationConfiguration` document.
 * @returns Every queue, topic and function rule.
 */
function rulesOf(xml: string): string[] {
  return [...xml.matchAll(/<(QueueConfiguration|TopicConfiguration|CloudFunctionConfiguration)>[\s\S]*?<\/\1>/g)].map(match => match[0]);
}

/**
 * Reads the managed rule's target and event names from a configuration.
 *
 * @param xml - A `NotificationConfiguration` document.
 * @param id - The managed rule's identifier.
 * @returns The rule's target and sorted events, or `undefined` when it has none.
 */
function managedRule(xml: string, id: string): { readonly target: string; readonly events: string[] } | undefined {
  const rule = rulesOf(xml).find(candidate => candidate.startsWith("<QueueConfiguration>") && candidate.includes(`<Id>${escapeXml(id)}</Id>`));
  if (rule === undefined)
    return undefined;
  return { target: /<Queue>([^<]*)<\/Queue>/.exec(rule)?.[1] ?? "", events: [...rule.matchAll(/<Event>([^<]*)<\/Event>/g)].map(match => match[1]!).sort() };
}

/**
 * Builds a configuration with the managed rule replaced, keeping every other rule.
 *
 * @param current - The current document.
 * @param id - The managed rule's identifier.
 * @param target - The notification target.
 * @param events - The S3 event names.
 * @returns The new document.
 */
function withManagedRule(current: string, id: string, target: string, events: readonly string[]): string {
  const others = rulesOf(current).filter(rule => !(rule.startsWith("<QueueConfiguration>") && rule.includes(`<Id>${escapeXml(id)}</Id>`)));
  const managed = `<QueueConfiguration><Id>${escapeXml(id)}</Id><Queue>${escapeXml(target)}</Queue>${events.map(event => `<Event>${event}</Event>`).join("")}</QueueConfiguration>`;
  return `<NotificationConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">${[...others, managed].join("")}</NotificationConfiguration>`;
}

/**
 * Creates a provisioner for S3-compatible object storage: it creates the
 * buckets the S3 bucket provider expects and, with `notifications`,
 * configures the store to publish create and delete notifications of buckets
 * with object event handlers to an existing notification target, in one
 * notification rule it owns (other rules are kept).
 *
 * Plans read only: a bucket is `create` when missing and `none` otherwise; the
 * notification rule is `create`, `update` (another target or events) or
 * `none`. Neither is destructive. Buckets are never deleted, and bucket
 * policies are never changed.
 *
 * @example
 * ```ts
 * s3.provisioner({ accessKeyId: credentialRef("S3_ADMIN_ACCESS_KEY_ID"), secretAccessKey: credentialRef("S3_ADMIN_SECRET_ACCESS_KEY"), notifications: { target: "arn:minio:sqs::primary:amqp" } });
 * ```
 *
 * @param options - Administrative credential references, scope and notification target.
 * @returns A provisioner for buckets and their notification rules.
 * @throws {HolqaError} `HOLQA_BINDING_CONFIG_INVALID` for invalid settings.
 */
export function provisioner(options: S3ProvisionerOptions): Provisioner {
  const name = options.name ?? "s3.provisioner";
  const problems: string[] = [];
  for (const field of ["accessKeyId", "secretAccessKey"] as const) {
    if (!isCredentialReference(options[field]))
      problems.push(`"${field}" must be a credential reference.`);
  }
  if (options.sessionToken !== undefined && !isCredentialReference(options.sessionToken))
    problems.push("\"sessionToken\" must be a credential reference.");
  if (options.notifications !== undefined && (typeof options.notifications.target !== "string" || options.notifications.target === ""))
    problems.push("\"notifications.target\" must be the store's notification target, for example an ARN.");
  if (problems.length > 0)
    throw new HolqaError(problems.map(problem => bindingFailure("configuration", { binding: name, message: `s3.provisioner: ${problem}` })));
  const ruleId = options.notifications?.id ?? "holqa";
  /**
   * Reports whether a runtime provider is in this provisioner's scope.
   *
   * @param provider - A selected provider.
   * @returns `true` for an S3 bucket provider in scope.
   */
  const claimed = (provider: AnyBindingProvider): boolean => provider.provider === "holqa.s3" && (options.providers === undefined || options.providers.includes(provider.name));
  /**
   * Connects to the store of one runtime provider with the provisioning credentials.
   *
   * @param context - The provisioning context, for credentials.
   * @param settings - The runtime provider's settings.
   * @returns A connection signed with the provisioning credentials.
   */
  const connectionOf = (context: ProvisioningContext, settings: BucketSettings): S3Connection => Object.freeze({
    endpoint: new URL(settings.endpoint),
    region: settings.region ?? "us-east-1",
    forcePathStyle: settings.forcePathStyle ?? true,
    credentials: {
      accessKeyId: context.credential(options.accessKeyId),
      secretAccessKey: context.credential(options.secretAccessKey),
      ...options.sessionToken === undefined ? {} : { sessionToken: context.credential(options.sessionToken) }
    },
    binding: name,
    timeoutMs: options.timeoutMs ?? 30_000,
    ...options.fetch === undefined ? {} : { fetch: options.fetch }
  });
  /**
   * Builds one planned change.
   *
   * @param change - The change without the provisioner's name and the destructive flag.
   * @returns The change.
   */
  const planned = (change: Omit<PlannedChange, "provisioner" | "destructive">): PlannedChange => Object.freeze({ provisioner: name, ...change, destructive: false });
  /**
   * Lists the claimed buckets with their store names, connections and the event names their handlers need.
   *
   * @param context - The provisioning context.
   * @returns One entry per claimed bucket.
   */
  const bucketsOf = (context: ProvisioningContext): Array<{ readonly resource: string; readonly bucket: string; readonly settings: BucketSettings; readonly events: string[] }> => context.resources.filter(({ resource, provider }) => resource.kind === "bucket" && claimed(provider)).map(({ resource, provider }) => {
    const settings = provider.settings as unknown as BucketSettings;
    const advertised = settings.events?.types ?? [];
    const types = new Set(context.handlers.filter(handler => handler.trigger.resource.id === resource.id).map(handler => handler.trigger.kind === "bucket.object-created" ? "object.created" : handler.trigger.kind === "bucket.object-deleted" ? "object.deleted" : undefined).filter((type): type is "object.created" | "object.deleted" => type !== undefined && advertised.includes(type)));
    return { resource: resource.id as string, bucket: settings.buckets?.[resource.id] ?? `${settings.prefix ?? ""}${resource.id}`, settings, events: [...types].map(type => eventNames[type]).sort() };
  });

  return Object.freeze({
    provisioningProtocol: provisioningProtocolVersion,
    provisioner: "holqa.s3.provisioner",
    name,
    settings: Object.freeze({ ...options.notifications === undefined ? {} : { notifications: Object.freeze({ target: options.notifications.target, id: ruleId }) }, ...options.providers === undefined ? {} : { providers: Object.freeze([...options.providers]) } }),
    credentials: Object.freeze([options.accessKeyId, options.secretAccessKey, ...options.sessionToken === undefined ? [] : [options.sessionToken]]),
    supports: (provider: AnyBindingProvider, resource: ResourceDescriptor) => resource.kind === "bucket" && claimed(provider),
    plan: async (context: ProvisioningContext) => {
      const changes: PlannedChange[] = [];
      const diagnostics: Diagnostic[] = [];
      for (const entry of bucketsOf(context)) {
        const connection = connectionOf(context, entry.settings);
        const exists = await bucketExists(connection, entry.bucket);
        changes.push(planned({ type: "s3.bucket", target: entry.bucket, resource: entry.resource, action: exists ? "none" : "create", reason: exists ? "The bucket exists." : "The bucket does not exist.", details: { endpoint: entry.settings.endpoint, region: connection.region } }));
        if (entry.events.length === 0)
          continue;
        if (options.notifications === undefined) {
          diagnostics.push(createDiagnostic({ code: diagnosticCodes.provisioningConfigInvalid, severity: "warning", message: `The bucket "${entry.bucket}" has object event handlers, but this provisioner has no notification target, so the store's notifications are not configured.`, hint: "Configure the store to publish create and delete notifications to the event channel yourself, or set \"notifications.target\".", details: { bucket: entry.bucket } }));
          continue;
        }
        const current = exists ? managedRule(await getBucketNotification(connection, entry.bucket), ruleId) : undefined;
        const matches = current !== undefined && current.target === options.notifications.target && JSON.stringify(current.events) === JSON.stringify(entry.events);
        changes.push(planned({
          type: "s3.bucket-notification",
          target: entry.bucket,
          resource: entry.resource,
          action: current === undefined ? "create" : matches ? "none" : "update",
          reason: current === undefined ? `The bucket has no notification rule "${ruleId}".` : matches ? "The notification rule is as needed." : "The notification rule has another target or other events; other rules are kept.",
          details: { id: ruleId, target: options.notifications.target, events: entry.events, endpoint: entry.settings.endpoint }
        }));
      }
      const outputs: JsonObject = { buckets: bucketsOf(context).map(entry => entry.bucket) };
      return { changes, diagnostics, outputs };
    },
    apply: async (context: ProvisioningContext, changes: readonly PlannedChange[]) => {
      const applied: AppliedChange[] = [];
      const entries = new Map(bucketsOf(context).map(entry => [entry.bucket, entry]));
      for (const change of changes) {
        const entry = entries.get(change.target);
        if (entry === undefined) {
          applied.push({ change, status: "skipped", message: "Not a bucket this provisioner manages." });
          continue;
        }
        const connection = connectionOf(context, entry.settings);
        try {
          if (change.type === "s3.bucket") {
            await createBucket(connection, entry.bucket);
          } else if (change.type === "s3.bucket-notification" && options.notifications !== undefined) {
            const current = await getBucketNotification(connection, entry.bucket);
            await putBucketNotification(connection, entry.bucket, withManagedRule(current, ruleId, options.notifications.target, entry.events));
          } else {
            applied.push({ change, status: "skipped", message: "Not a change this provisioner makes." });
            continue;
          }
          applied.push({ change, status: "applied" });
        } catch (error) {
          applied.push({ change, status: "failed", message: error instanceof Error ? error.message : String(error) });
          break;
        }
      }
      return applied;
    }
  });
}