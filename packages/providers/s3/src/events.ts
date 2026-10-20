import type {
  DeliverySource,
  DeliveryTrace,
  LeasedDelivery,
  ObjectEvent,
  ObjectEventSubscription,
  ObjectEventType
} from "@holqa/core";

import { objectEventFormat } from "@holqa/core";

import { sha256Hex } from "@/sigv4";

/** One S3 event notification record, as the parts Holqa reads. */
export interface S3EventRecord {
  readonly type: ObjectEventType;
  /** The bucket name the store reported. */
  readonly bucketName: string;
  /** The object key, decoded. */
  readonly key: string;
  readonly size?: number;
  readonly etag?: string;
  /** When the change happened (ISO 8601). */
  readonly time: string;
  /** The store's ordering token of changes to one key; part of the event identity. */
  readonly sequencer: string;
  /** The store's event name, for example `s3:ObjectCreated:Put`. */
  readonly eventName: string;
  /** The writer's trace, when the store includes user metadata in notifications (MinIO does; AWS S3 does not). */
  readonly trace?: DeliveryTrace;
}

/**
 * Reads the writer's trace from a record's user metadata, ignoring anything malformed.
 *
 * @param metadata - The record's `userMetadata`, if any.
 * @returns The trace, or `undefined`.
 */
function traceFrom(metadata: unknown): DeliveryTrace | undefined {
  if (typeof metadata !== "object" || metadata === null)
    return undefined;
  const entry = Object.entries(metadata).find(([name]) => name.toLowerCase() === "x-amz-meta-holqa-trace");
  if (entry === undefined || typeof entry[1] !== "string")
    return undefined;
  try {
    const trace: unknown = JSON.parse(decodeURIComponent(entry[1]));
    return typeof trace === "object" && trace !== null && typeof (trace as { readonly correlationId?: unknown }).correlationId === "string" ? trace as DeliveryTrace : undefined;
  } catch {
    // Not Holqa's trace; the event starts a new lineage.
    return undefined;
  }
}

/**
 * Reads an S3 event notification (the `Records` format AWS S3, MinIO, Ceph and
 * others publish). Holqa reads notifications with exactly one record, which
 * is what these stores send per change.
 *
 * @param body - The raw notification bytes.
 * @returns The record, or a sentence saying why the notification cannot be read.
 */
export function readS3Notification(body: Uint8Array): S3EventRecord | string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return "the notification is not JSON";
  }
  const records = (parsed as { readonly Records?: unknown } | null)?.Records;
  if (!Array.isArray(records) || records.length !== 1)
    return "the notification must carry exactly one record";
  const record = records[0] as { readonly eventName?: unknown; readonly eventTime?: unknown; readonly s3?: { readonly bucket?: { readonly name?: unknown }; readonly object?: { readonly key?: unknown; readonly size?: unknown; readonly eTag?: unknown; readonly sequencer?: unknown; readonly userMetadata?: unknown } } };
  const eventName = typeof record.eventName === "string" ? record.eventName : "";
  const type: ObjectEventType | undefined = /(?:^|:)ObjectCreated:/.test(eventName) ? "object.created" : /(?:^|:)ObjectRemoved:/.test(eventName) ? "object.deleted" : undefined;
  const object = record.s3?.object;
  const bucketName = record.s3?.bucket?.name;
  if (type === undefined)
    return `the event "${eventName}" is neither a creation nor a removal`;
  if (typeof object?.key !== "string" || typeof bucketName !== "string" || typeof record.eventTime !== "string" || Number.isNaN(Date.parse(record.eventTime)))
    return "the record lacks a bucket, key or event time";
  let key: string;
  try {
    // Keys in notifications are URL-encoded, with "+" for spaces.
    key = decodeURIComponent(object.key.replaceAll("+", " "));
  } catch {
    return "the record's key is not valid URL encoding";
  }
  return Object.freeze({
    type,
    bucketName,
    key,
    ...typeof object.size === "number" ? { size: object.size } : {},
    ...typeof object.eTag === "string" && object.eTag !== "" ? { etag: object.eTag.replaceAll("\"", "") } : {},
    time: new Date(record.eventTime).toISOString(),
    sequencer: typeof object.sequencer === "string" ? object.sequencer : "",
    eventName,
    ...type === "object.created" && traceFrom(object.userMetadata) !== undefined ? { trace: traceFrom(object.userMetadata)! } : {}
  });
}

/**
 * Converts a record into Holqa's portable object event. The event identifier
 * is derived from the bucket, key, event name and sequencer, so every
 * redelivery of one notification has the same identifier.
 *
 * @param record - One S3 notification record.
 * @param bucketId - The Holqa bucket identifier the event is reported for.
 * @returns The `holqa.object-event/1` event.
 */
export function objectEventFromS3(record: S3EventRecord, bucketId: string): ObjectEvent {
  const id = sha256Hex(`${record.bucketName}\n${record.key}\n${record.eventName}\n${record.sequencer}\n${record.time}`).slice(0, 32);
  return record.type === "object.created"
    ? { format: objectEventFormat, id, type: "object.created", bucket: bucketId, time: record.time, object: { key: record.key, size: record.size ?? 0, ...record.etag === undefined ? {} : { etag: record.etag } } }
    : { format: objectEventFormat, id, type: "object.deleted", bucket: bucketId, time: record.time, object: { key: record.key } };
}

/**
 * Turns a channel's raw notifications into one subscription's object
 * events. Notifications of other buckets, types or prefixes are acknowledged
 * and skipped (the store's notification rule may be broader than the
 * subscription); unreadable ones are dead-lettered with
 * `HOLQA_PAYLOAD_MALFORMED`, so they are never redelivered to a handler that
 * could not read them either.
 *
 * @param raw - The channel's source for the subscription.
 * @param subscription - The handler's subscription.
 * @param bucketId - The Holqa bucket identifier.
 * @param bucketName - The store's bucket name.
 * @returns The subscription's object event source.
 */
export function objectEventSource(raw: DeliverySource<Uint8Array>, subscription: ObjectEventSubscription, bucketId: string, bucketName: string): DeliverySource<ObjectEvent> {
  return Object.freeze<DeliverySource<ObjectEvent>>({
    receive: async (request) => {
      const deliveries: Array<LeasedDelivery<ObjectEvent>> = [];
      for (const delivery of await raw.receive(request)) {
        const record = readS3Notification(delivery.body);
        if (typeof record === "string") {
          await raw.deadLetter(delivery.receipt, { code: "HOLQA_PAYLOAD_MALFORMED", message: `Unreadable storage notification: ${record}.`, attempt: delivery.attempt });
          continue;
        }
        if (record.bucketName !== bucketName || !subscription.types.includes(record.type) || !record.key.startsWith(subscription.prefix ?? "")) {
          await raw.acknowledge(delivery.receipt);
          continue;
        }
        const event = objectEventFromS3(record, bucketId);
        const trace = record.trace ?? delivery.trace;
        deliveries.push(Object.freeze({ receipt: delivery.receipt, id: event.id, attempt: delivery.attempt, body: event, sentAt: record.time, ...trace === undefined ? {} : { trace } }));
      }
      return deliveries;
    },
    acknowledge: receipt => raw.acknowledge(receipt),
    retry: (receipt, delayMs, failure) => raw.retry(receipt, delayMs, failure),
    deadLetter: (receipt, failure) => raw.deadLetter(receipt, failure),
    discard: (receipt, failure) => raw.discard(receipt, failure),
    ...raw.extend === undefined ? {} : { extend: raw.extend },
    wait: signal => raw.wait(signal)
  });
}