import type {
  BucketAccess,
  BucketDriver,
  DeliveryTrace,
  ListObjectsOptions,
  ObjectEvent,
  ObjectEventSource,
  ObjectEventType,
  ObjectList,
  ObjectMetadata,
  PutObjectOptions,
  ResourceDescriptorOf,
  SignedUrl,
  SignedUrlOptions
} from "@holqa/core";
import type { Database } from "bun:sqlite";

import type { Clock } from "@/clock";
import type {
  DeliveryError,
  DeliveryState,
  LeaseStore
} from "@/state/lease-store";
import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual
} from "node:crypto";
import {
  mkdirSync,
  renameSync,
  rmSync
} from "node:fs";

import { join } from "node:path";
import {
  checkObjectKey,
  diagnosticCodes,
  failWith,
  objectEventFormat,
  objectEventTypes,
  readObjectEvent
} from "@holqa/core";

/** One object event, as inspection reports it. */
export interface LocalObjectEvent {
  readonly event: ObjectEvent;
  /** The trace of the invocation that changed the object, when one did and a subscription received the event. */
  readonly trace?: DeliveryTrace;
  /** The event's delivery to each subscribed handler. */
  readonly deliveries: ReadonlyArray<{
    readonly subscription: string;
    readonly state: DeliveryState;
    readonly attempts: number;
    /** When the delivery is due again or its lease ends (ISO 8601); for settled deliveries, the last change. */
    readonly visibleAt: string;
    readonly lastError?: DeliveryError;
  }>;
}

/**
 * Inspection, failure simulation and signed URL serving for the local buckets.
 */
export interface LocalStorage {
  /** Lists a bucket's events, oldest first, with each subscription's delivery state. */
  readonly events: (bucketId: string) => LocalObjectEvent[];
  /** Lists a bucket's stored objects in key order (UTF-8 bytes), optionally only keys with a prefix. */
  readonly objects: (bucketId: string, prefix?: string) => ObjectMetadata[];
  /** Makes dead-lettered events of one subscription due again; all of them when `eventId` is absent. Returns how many. */
  readonly redriveEvents: (bucketId: string, subscription: string, eventId?: string) => number;
  /** Delivers a known event once more to one subscription, with the same event identifier. */
  readonly duplicateEvent: (bucketId: string, subscription: string, eventId: string) => boolean;
  /**
   * Removes a bucket's subscriptions that are not listed, so that no further
   * events are recorded for handlers that no longer exist (for example after a
   * handler was renamed during development). Deliveries already recorded for
   * them are kept. A removed subscription that subscribes again receives only
   * later events.
   *
   * @returns The identifiers of the removed subscriptions, sorted.
   */
  readonly retainSubscriptions: (bucketId: string, subscriptions: readonly string[]) => string[];
  /**
   * Serves signed URLs (and unsigned reads of `public-read` buckets) issued by
   * this environment: `GET`, `HEAD` and `PUT` under the signed URL base path.
   * Mount it next to the runtime's own `fetch`. Requests outside the base path
   * get `404`.
   */
  readonly fetch: (request: Request) => Promise<Response>;
  /** Reports whether a request is addressed to {@link fetch}, by its path. */
  readonly handles: (request: Request) => boolean;
}

/** Settings of {@link createLocalStorage}. */
export interface LocalStorageSettings {
  readonly database: Database;
  readonly store: LeaseStore;
  readonly clock: Clock;
  readonly createId: () => string;
  /** Where object bytes are kept. */
  readonly directory: string;
  /** The absolute URL signed URLs start with, for example `http://127.0.0.1:3000/_holqa/storage`. */
  readonly signedUrlBase: string;
  /** The largest body a signed `PUT` accepts, in bytes. */
  readonly maxUploadBytes: number;
  /** Access policies by bucket identifier. */
  readonly access: ReadonlyMap<string, BucketAccess>;
}

/** A row of the `objects` table. */
interface ObjectRow {
  readonly key: string;
  readonly size: number;
  readonly content_type: string | null;
  readonly etag: string;
  readonly last_modified: number;
  readonly blob: string;
}

/**
 * The channel of one subscription's object events.
 *
 * @param bucketId - The bucket's logical identifier.
 * @param subscription - The subscribing handler.
 * @returns The channel name.
 */
export function eventChannel(bucketId: string, subscription: string): string {
  return `events:${bucketId}:${subscription}`;
}

/**
 * Creates the storage part of a local environment. Object bytes live in files
 * named after a hash of the key, so keys never become file system paths;
 * metadata, events and deliveries live in the state database. A write stores
 * the new file first and switches the metadata in a transaction, so readers
 * never see a partly written object.
 *
 * @param settings - The database, files, clock and signed URL settings.
 * @returns The driver and source factories, and the inspection and serving API.
 */
export function createLocalStorage(settings: LocalStorageSettings): {
  readonly driver: (resource: ResourceDescriptorOf<"bucket">) => BucketDriver;
  readonly source: (resource: ResourceDescriptorOf<"bucket">) => ObjectEventSource;
  readonly storage: LocalStorage;
} {
  const { database, store, clock, createId, directory } = settings;
  const signingKey = loadSigningKey(database);
  const base = new URL(settings.signedUrlBase);
  const basePath = base.pathname.replace(/\/$/, "");

  /**
   * Returns the directory of a bucket's object files.
   *
   * @param bucketId - The bucket's logical identifier.
   * @returns The directory path; bucket identifiers are safe path segments.
   */
  const bucketDirectory = (bucketId: string): string => join(directory, bucketId);

  /**
   * Reads one object's metadata row.
   *
   * @param bucketId - The bucket's logical identifier.
   * @param key - The object key, already validated.
   * @returns The row, or `null`.
   */
  const row = (bucketId: string, key: string): ObjectRow | null => database.query<ObjectRow, [string, string]>("SELECT key, size, content_type, etag, last_modified, blob FROM objects WHERE bucket = ? AND key = ?").get(bucketId, key);

  /**
   * Records an event and a delivery for every matching subscription.
   *
   * @param bucketId - The bucket's logical identifier.
   * @param type - What happened.
   * @param object - The object the event reports on.
   * @param trace - The trace of the invocation that changed the object, stored with each delivery.
   * @returns The channels that received a delivery.
   */
  const emit = (bucketId: string, type: ObjectEventType, object: ObjectEvent["object"], trace: DeliveryTrace | undefined): string[] => {
    const time = clock.now();
    const event: ObjectEvent = { format: objectEventFormat, id: createId(), type, bucket: bucketId, time: new Date(time).toISOString(), object };
    const body = JSON.stringify(event);
    database.query("INSERT INTO object_events (id, bucket, type, key, time, body) VALUES (?, ?, ?, ?, ?, ?)").run(event.id, bucketId, type, object.key, time, body);
    const subscriptions = database.query<{ subscription: string; types: string; prefix: string }, [string]>("SELECT subscription, types, prefix FROM event_subscriptions WHERE bucket = ?").all(bucketId);
    const channels: string[] = [];
    for (const subscription of subscriptions) {
      const stored: unknown = JSON.parse(subscription.types);
      const types = Array.isArray(stored) ? objectEventTypes.filter(candidate => stored.includes(candidate)) : [];
      if (!types.includes(type) || !object.key.startsWith(subscription.prefix))
        continue;
      const channel = eventChannel(bucketId, subscription.subscription);
      store.add(channel, event.id, body, 0, trace);
      channels.push(channel);
    }
    return channels;
  };

  /**
   * Stores an object and emits `object.created`.
   *
   * @param bucketId - The bucket's logical identifier.
   * @param key - A validated key.
   * @param body - The bytes.
   * @param options - The content type.
   * @param trace - The trace of the invocation that writes the object, if any.
   * @returns The stored object's metadata.
   */
  const put = async (bucketId: string, key: string, body: Uint8Array, options: PutObjectOptions, trace?: DeliveryTrace): Promise<ObjectMetadata> => {
    const folder = bucketDirectory(bucketId);
    mkdirSync(folder, { recursive: true });
    const etag = createHash("sha256").update(body).digest("hex");
    const blob = `${createHash("sha256").update(key).digest("hex").slice(0, 32)}.${createId()}`;
    const temporary = join(folder, `${blob}.partial`);
    await Bun.write(temporary, body);
    renameSync(temporary, join(folder, blob));
    const lastModified = clock.now();
    let previous: string | undefined;
    let channels: string[];
    try {
      channels = database.transaction(() => {
        previous = row(bucketId, key)?.blob;
        database.query("INSERT INTO objects (bucket, key, size, content_type, etag, last_modified, blob) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (bucket, key) DO UPDATE SET size = excluded.size, content_type = excluded.content_type, etag = excluded.etag, last_modified = excluded.last_modified, blob = excluded.blob")
          .run(bucketId, key, body.length, options.contentType ?? null, etag, lastModified, blob);
        return emit(bucketId, "object.created", { key, size: body.length, ...options.contentType === undefined ? {} : { contentType: options.contentType }, etag }, trace);
      })();
    } catch (error) {
      rmSync(join(folder, blob), { force: true });
      throw error;
    }
    if (previous !== undefined)
      rmSync(join(folder, previous), { force: true });
    for (const channel of channels)
      store.notify(channel);
    return metadataOf({ key, size: body.length, content_type: options.contentType ?? null, etag, last_modified: lastModified, blob });
  };

  /**
   * Reads an object's bytes.
   *
   * @param bucketId - The bucket's logical identifier.
   * @param key - A validated key.
   * @returns The bytes, or `undefined` when the object does not exist.
   */
  const get = async (bucketId: string, key: string): Promise<Uint8Array | undefined> => {
    const found = row(bucketId, key);
    return found === null ? undefined : Bun.file(join(bucketDirectory(bucketId), found.blob)).bytes();
  };

  /**
   * Signs a URL for one object.
   *
   * @param bucketId - The bucket's logical identifier.
   * @param key - A validated key.
   * @param options - Method, expiry and content type.
   * @returns The signed URL.
   */
  const signUrl = async (bucketId: string, key: string, options: SignedUrlOptions): Promise<SignedUrl> => {
    const expires = Math.floor(clock.now() / 1000) + options.expiresInSeconds;
    const url = new URL(`${basePath}/${bucketId}/${key.split("/").map(encodeURIComponent).join("/")}`, base);
    url.searchParams.set("method", options.method);
    url.searchParams.set("expires", String(expires));
    if (options.contentType !== undefined)
      url.searchParams.set("content-type", options.contentType);
    url.searchParams.set("signature", sign(signingKey, options.method, bucketId, key, expires, options.contentType));
    return Object.freeze({
      url: url.toString(),
      method: options.method,
      expiresAt: new Date(expires * 1000).toISOString(),
      headers: Object.freeze(options.contentType === undefined ? {} : { "content-type": options.contentType })
    });
  };

  /**
   * Serves one request addressed to a signed URL.
   *
   * @param request - An incoming Fetch request.
   * @returns The response; failures use Holqa's HTTP error body.
   */
  const serveSigned = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (!url.pathname.startsWith(`${basePath}/`))
      return failure(404, diagnosticCodes.objectNotFound, "No object is served at this path.");
    const [bucketId, ...segments] = url.pathname.slice(basePath.length + 1).split("/");
    let key: string;
    try {
      key = segments.map(decodeURIComponent).join("/");
    } catch {
      // A malformed percent-encoding cannot name an object; report it as such.
      return failure(400, diagnosticCodes.objectKeyInvalid, "The object key in the URL is not valid percent-encoding.");
    }
    const access = bucketId === undefined ? undefined : settings.access.get(bucketId);
    if (bucketId === undefined || access === undefined || checkObjectKey(key, "signed URL") !== undefined)
      return failure(404, diagnosticCodes.objectNotFound, "No object is served at this path.");
    const method = request.method === "HEAD" ? "GET" : request.method;
    if (method !== "GET" && method !== "PUT")
      return failure(405, diagnosticCodes.httpMethodNotAllowed, "Signed URLs accept GET, HEAD and PUT.", { allow: "GET, HEAD, PUT" });
    const unsignedRead = method === "GET" && access === "public-read" && !url.searchParams.has("signature");
    if (!unsignedRead) {
      const problem = verify(signingKey, url, method, bucketId, key, Math.floor(clock.now() / 1000));
      if (problem !== undefined)
        return failure(403, diagnosticCodes.signedUrlInvalid, problem);
    }
    if (method === "PUT") {
      const required = url.searchParams.get("content-type");
      const contentType = request.headers.get("content-type") ?? undefined;
      if (required !== null && contentType !== required)
        return failure(403, diagnosticCodes.signedUrlInvalid, `The upload must be sent with content-type "${required}".`);
      const declared = Number(request.headers.get("content-length") ?? "0");
      const body = declared > settings.maxUploadBytes ? undefined : await readLimited(request, settings.maxUploadBytes);
      if (body === undefined)
        return failure(413, diagnosticCodes.operationInvalid, `Uploads are limited to ${settings.maxUploadBytes} bytes.`);
      const stored = await put(bucketId, key, body, contentType === undefined ? {} : { contentType });
      return Response.json({ key: stored.key, size: stored.size, etag: stored.etag });
    }
    const found = row(bucketId, key);
    if (found === null)
      return failure(404, diagnosticCodes.objectNotFound, "The object does not exist.");
    const headers = { "content-type": found.content_type ?? "application/octet-stream", "etag": `"${found.etag}"`, "content-length": String(found.size) };
    return new Response(request.method === "HEAD" ? null : Bun.file(join(bucketDirectory(bucketId), found.blob)), { headers });
  };

  return {
    driver: resource => Object.freeze<BucketDriver>({
      put: async (key, body, options, context) => put(resource.id, key, body, options, context?.trace),
      get: async key => get(resource.id, key),
      head: async (key) => {
        const found = row(resource.id, key);
        return found === null ? undefined : metadataOf(found);
      },
      delete: async (key, context) => {
        const result = database.transaction(() => {
          const found = row(resource.id, key);
          if (found === null)
            return undefined;
          database.query("DELETE FROM objects WHERE bucket = ? AND key = ?").run(resource.id, key);
          return { blob: found.blob, channels: emit(resource.id, "object.deleted", { key }, context?.trace) };
        })();
        if (result === undefined)
          return false;
        rmSync(join(bucketDirectory(resource.id), result.blob), { force: true });
        for (const channel of result.channels)
          store.notify(channel);
        return true;
      },
      list: async options => list(database, resource.id, options),
      signUrl: async (key, options) => signUrl(resource.id, key, options)
    }),
    source: resource => Object.freeze<ObjectEventSource>({
      subscribe: async (subscription) => {
        database.query("INSERT INTO event_subscriptions (bucket, subscription, types, prefix) VALUES (?, ?, ?, ?) ON CONFLICT (bucket, subscription) DO UPDATE SET types = excluded.types, prefix = excluded.prefix")
          .run(resource.id, subscription.id, JSON.stringify([...subscription.types].sort()), subscription.prefix ?? "");
        return store.source<ObjectEvent>(eventChannel(resource.id, subscription.id), body => readObjectEvent(JSON.parse(body), `object event for bucket "${resource.id}"`));
      }
    }),
    storage: Object.freeze({
      events: (bucketId: string) => {
        const events = database.query<{ body: string }, [string]>("SELECT body FROM object_events WHERE bucket = ? ORDER BY seq").all(bucketId).map(event => readObjectEvent(JSON.parse(event.body), `stored object event of bucket "${bucketId}"`));
        const subscriptions = database.query<{ subscription: string }, [string]>("SELECT subscription FROM event_subscriptions WHERE bucket = ? ORDER BY subscription").all(bucketId);
        const deliveries = subscriptions.flatMap(({ subscription }) => store.list(eventChannel(bucketId, subscription)).map(delivery => ({ subscription, delivery })));
        return events.map((event) => {
          const own = deliveries.filter(({ delivery }) => delivery.id === event.id);
          const trace = own.find(({ delivery }) => delivery.trace !== undefined)?.delivery.trace;
          return Object.freeze({
            event,
            ...trace === undefined ? {} : { trace },
            deliveries: own.map(({ subscription, delivery }) => Object.freeze({
              subscription,
              state: delivery.state,
              attempts: delivery.attempts,
              visibleAt: new Date(delivery.visibleAt).toISOString(),
              ...delivery.lastError === undefined ? {} : { lastError: delivery.lastError }
            }))
          });
        });
      },
      objects: (bucketId: string, prefix = "") => database.query<ObjectRow, [string]>("SELECT key, size, content_type, etag, last_modified, blob FROM objects WHERE bucket = ? ORDER BY key")
        .all(bucketId)
        .filter(object => object.key.startsWith(prefix))
        .map(metadataOf),
      redriveEvents: (bucketId: string, subscription: string, eventId?: string) => store.redrive(eventChannel(bucketId, subscription), eventId === undefined ? {} : { id: eventId }),
      duplicateEvent: (bucketId: string, subscription: string, eventId: string) => store.duplicate(eventChannel(bucketId, subscription), eventId),
      retainSubscriptions: (bucketId: string, subscriptions: readonly string[]) => database.transaction(() => {
        const keep = new Set(subscriptions);
        const stale = database.query<{ subscription: string }, [string]>("SELECT subscription FROM event_subscriptions WHERE bucket = ? ORDER BY subscription").all(bucketId).map(row => row.subscription).filter(subscription => !keep.has(subscription));
        for (const subscription of stale)
          database.query("DELETE FROM event_subscriptions WHERE bucket = ? AND subscription = ?").run(bucketId, subscription);
        return stale;
      })(),
      fetch: serveSigned,
      handles: (request: Request) => new URL(request.url).pathname.startsWith(`${basePath}/`)
    })
  };
}

/** The longest cursor accepted, in characters; longer values cannot come from {@link list}. */
const maxCursorLength = 2_000;

/**
 * Lists one page of a bucket in key order (UTF-8 bytes, SQLite's binary
 * collation). The cursor is the base64url encoding of the last key returned.
 *
 * @param database - The state database.
 * @param bucketId - The bucket's logical identifier.
 * @param options - Prefix, cursor and limit, already validated by the SDK.
 * @returns The page.
 * @throws {HolqaError} `HOLQA_OPERATION_INVALID` for a cursor this driver did not issue.
 */
function list(database: Database, bucketId: string, options: ListObjectsOptions): ObjectList {
  const prefix = options.prefix ?? "";
  const limit = options.limit ?? 100;
  let after = "";
  if (options.cursor !== undefined) {
    const decoded = options.cursor.length <= maxCursorLength && /^[\w-]+$/.test(options.cursor) ? Buffer.from(options.cursor, "base64url").toString("utf8") : "";
    if (decoded === "" || !decoded.startsWith(prefix))
      failWith(diagnosticCodes.operationInvalid, `The cursor for bucket "${bucketId}" was not issued for this listing.`);
    after = decoded;
  }
  const rows = database.query<ObjectRow, [string, string, string, number]>(
    "SELECT key, size, content_type, etag, last_modified, blob FROM objects WHERE bucket = ?1 AND substr(key, 1, length(?2)) = ?2 AND key > ?3 ORDER BY key LIMIT ?4"
  ).all(bucketId, prefix, after, limit + 1);
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return Object.freeze({
    objects: Object.freeze(page.map(metadataOf)),
    ...rows.length > limit && last !== undefined ? { cursor: Buffer.from(last.key, "utf8").toString("base64url") } : {}
  });
}

/**
 * Converts a metadata row into portable object metadata.
 *
 * @param found - The row.
 * @returns Portable object metadata.
 */
function metadataOf(found: ObjectRow): ObjectMetadata {
  return Object.freeze({
    key: found.key,
    size: found.size,
    ...found.content_type === null ? {} : { contentType: found.content_type },
    etag: found.etag,
    lastModified: new Date(found.last_modified).toISOString()
  });
}

/**
 * Returns the environment's signed URL key, creating it on first use. The
 * key is stored in the state directory so URLs survive restarts; deleting the
 * state invalidates every URL.
 *
 * @param database - The state database.
 * @returns The key bytes.
 */
function loadSigningKey(database: Database): Buffer {
  const existing = database.query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'signing-key'").get();
  if (existing !== null)
    return Buffer.from(existing.value, "hex");
  const key = randomBytes(32);
  database.query("INSERT OR IGNORE INTO meta (key, value) VALUES ('signing-key', ?)").run(key.toString("hex"));
  return Buffer.from(database.query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'signing-key'").get()!.value, "hex");
}

/**
 * Computes the signature of a URL's protected parts: method, bucket, key,
 * expiry and, for uploads, the required content type.
 *
 * @param key - The signing key.
 * @param method - `GET` or `PUT`.
 * @param bucketId - The bucket's logical identifier.
 * @param objectKey - The key of the object the URL grants access to.
 * @param expires - Expiry in epoch seconds.
 * @param contentType - The required upload content type, if any.
 * @returns The hex-encoded HMAC-SHA256.
 */
function sign(key: Buffer, method: string, bucketId: string, objectKey: string, expires: number, contentType: string | undefined): string {
  return createHmac("sha256", key).update(["holqa-local-signed-url/1", method, bucketId, objectKey, String(expires), contentType ?? ""].join("\n")).digest("hex");
}

/**
 * Checks a signed URL.
 *
 * @param key - The signing key.
 * @param url - The requested URL.
 * @param method - The request method (`HEAD` counts as `GET`).
 * @param bucketId - The bucket in the path.
 * @param objectKey - The object key in the path.
 * @param now - The current time in epoch seconds.
 * @returns Why the URL is rejected, or `undefined` when it is valid.
 */
function verify(key: Buffer, url: URL, method: string, bucketId: string, objectKey: string, now: number): string | undefined {
  const signature = url.searchParams.get("signature") ?? "";
  const expires = Number(url.searchParams.get("expires"));
  if (url.searchParams.get("method") !== method)
    return "The URL was not signed for this method.";
  if (!Number.isSafeInteger(expires))
    return "The URL has no valid expiry.";
  const expected = Buffer.from(sign(key, method, bucketId, objectKey, expires, url.searchParams.get("content-type") ?? undefined), "hex");
  const given = Buffer.from(/^[0-9a-f]{64}$/.test(signature) ? signature : "", "hex");
  if (given.length !== expected.length || !timingSafeEqual(given, expected))
    return "The URL's signature does not match.";
  if (now >= expires)
    return "The URL has expired.";
  return undefined;
}

/**
 * Reads a request body, stopping as soon as it exceeds a limit, so that an
 * upload without a `content-length` cannot make the server buffer more than
 * the limit.
 *
 * @param request - The upload request.
 * @param limit - The largest accepted body, in bytes.
 * @returns The body, or `undefined` when it is larger than `limit`.
 */
async function readLimited(request: Request, limit: number): Promise<Uint8Array | undefined> {
  if (request.body === null)
    return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = request.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done)
      break;
    size += value.length;
    if (size > limit) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.length;
  }
  return body;
}

/**
 * Builds an error response with Holqa's HTTP error body.
 *
 * @param status - The HTTP status.
 * @param code - The diagnostic code.
 * @param message - A message safe to show callers.
 * @param headers - Extra headers.
 * @returns The response.
 */
function failure(status: number, code: string, message: string, headers: Readonly<Record<string, string>> = {}): Response {
  return Response.json({ error: { code, message } }, { status, headers });
}