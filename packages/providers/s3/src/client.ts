import type {
  DeliveryTrace,
  ObjectList,
  ObjectMetadata,
  SignedUrl,
  SignedUrlOptions
} from "@holqa/core";

import type { SigningCredentials } from "@/sigv4";

import {
  bindingFailure,
  HolqaError
} from "@holqa/core";

import {
  presign,
  sha256Hex,
  signHeaders,
  uriEncode
} from "@/sigv4";

/** How to reach one S3-compatible service. */
export interface S3Connection {
  /** The service's base URL, for example `https://s3.eu-central-1.amazonaws.com` or `http://localhost:9000`. */
  readonly endpoint: URL;
  readonly region: string;
  /** `true`: `<endpoint>/<bucket>/<key>`; `false`: `<bucket>.<endpoint host>/<key>`. */
  readonly forcePathStyle: boolean;
  readonly credentials: SigningCredentials;
  /** The provider's name, for classified failures. */
  readonly binding: string;
  /** The time limit of one request, in milliseconds. */
  readonly timeoutMs: number;
  /** The Fetch implementation. Default the global `fetch`. */
  readonly fetch?: (request: Request) => Promise<Response>;
  /** The signing clock. Default the wall clock. */
  readonly now?: () => Date;
}

/** The user metadata header that records an object's declared content type, so reads report exactly what was written. */
const contentTypeMeta = "x-amz-meta-holqa-content-type";

/** The user metadata header that records the writer's trace, for stores that include user metadata in event notifications. */
export const traceMeta = "x-amz-meta-holqa-trace";

/** One request to the service. */
interface S3Request {
  readonly method: "GET" | "HEAD" | "PUT" | "DELETE";
  readonly bucket: string;
  readonly key?: string;
  readonly query?: Readonly<Record<string, string>>;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: Uint8Array;
}

/**
 * Builds the URL of a bucket or object.
 *
 * @param connection - The service.
 * @param bucket - The bucket name.
 * @param key - The object key, if any.
 * @returns The URL, with the key encoded as SigV4 requires.
 */
export function objectUrl(connection: S3Connection, bucket: string, key?: string): URL {
  const base = new URL(connection.endpoint);
  const encodedKey = key === undefined ? "" : uriEncode(key, true);
  const basePath = base.pathname.replace(/\/$/, "");
  if (connection.forcePathStyle) {
    base.pathname = `${basePath}/${bucket}${key === undefined ? "" : `/${encodedKey}`}`;
  } else {
    base.hostname = `${bucket}.${base.hostname}`;
    base.pathname = `${basePath}/${encodedKey}`;
  }
  return base;
}

/**
 * Reads the error code of an S3 error response body.
 *
 * @param text - The XML body.
 * @returns The `<Code>`, or `undefined`.
 */
function errorCode(text: string): string | undefined {
  return /<Code>([^<]+)<\/Code>/.exec(text)?.[1];
}

/**
 * Converts a failed response into a classified binding failure. Error
 * messages from the service are not repeated: they may name keys or buckets
 * in detail, but never contain credentials; the code is kept.
 *
 * @param connection - The service.
 * @param response - The failed response.
 * @param action - What was attempted, for the message.
 * @returns The error to throw.
 */
async function failure(connection: S3Connection, response: Response, action: string): Promise<HolqaError> {
  const code = errorCode(await response.text().catch(() => "")) ?? `HTTP ${response.status}`;
  const details = { status: response.status, reason: code };
  if (response.status === 401 || response.status === 403 || code === "InvalidAccessKeyId" || code === "SignatureDoesNotMatch" || code === "AccessDenied")
    return new HolqaError(bindingFailure("credentials-invalid", { binding: connection.binding, message: `The storage service rejected the credentials while ${action} (${code}).`, details }));
  if (response.status >= 500 || response.status === 429 || code === "SlowDown")
    return new HolqaError(bindingFailure("unavailable", { binding: connection.binding, message: `The storage service is unavailable while ${action} (${code}).`, details }));
  return new HolqaError(bindingFailure("failed", { binding: connection.binding, message: `The storage service refused ${action} (${code}).`, details }));
}

/**
 * Sends one signed request.
 *
 * @param connection - The service.
 * @param request - The method, URL, headers and body to send.
 * @param action - What is attempted, for failures.
 * @returns The response, of any status.
 * @throws {HolqaError} `HOLQA_BINDING_UNAVAILABLE` when the service cannot be reached or does not answer in time.
 */
async function send(connection: S3Connection, request: S3Request, action: string): Promise<Response> {
  const url = request.key === undefined && request.bucket === "" ? new URL(connection.endpoint) : objectUrl(connection, request.bucket, request.key);
  for (const [name, value] of Object.entries(request.query ?? {}))
    url.searchParams.set(name, value);
  const body = request.body ?? new Uint8Array();
  const headers = signHeaders({ method: request.method, url, headers: request.headers ?? {}, payloadHash: sha256Hex(body) }, connection.credentials, { region: connection.region, service: "s3", date: connection.now?.() ?? new Date() });
  // The Fetch implementation sets `host` from the URL; it was only needed for the signature.
  const { host: _host, ...sent } = headers;
  try {
    return await (connection.fetch ?? fetch)(new Request(url.href, { method: request.method, headers: sent, ...request.method === "PUT" ? { body } : {}, signal: AbortSignal.timeout(connection.timeoutMs) }));
  } catch {
    // The fetch error may contain the endpoint, never credentials; the classification is what callers need.
    throw new HolqaError(bindingFailure("unavailable", { binding: connection.binding, message: `The storage service could not be reached while ${action}.`, details: { reason: "network" } }));
  }
}

/**
 * Reads object metadata from response headers.
 *
 * @param key - Which object, unencoded.
 * @param response - A `HEAD` or `PUT` response.
 * @param size - The size, when the response does not carry it.
 * @param contentType - The content type, when known.
 * @returns Size, etag, content type and user metadata, or `undefined` when absent.
 */
function metadataFrom(key: string, response: Response, size?: number, contentType?: string): ObjectMetadata {
  // Objects written by this provider record their declared type; others (for example presigned uploads) report the service's,
  // except the generic defaults services assign when none was given.
  const served = response.headers.get("content-type");
  const declared = contentType ?? response.headers.get(contentTypeMeta) ?? (served === null || served === "binary/octet-stream" || served === "application/octet-stream" ? undefined : served);
  const modified = response.headers.get("last-modified");
  return Object.freeze({
    key,
    size: size ?? Number(response.headers.get("content-length") ?? "0"),
    ...declared === undefined || declared === "" ? {} : { contentType: declared },
    etag: (response.headers.get("etag") ?? "").replaceAll("\"", ""),
    lastModified: modified === null ? new Date().toISOString() : new Date(modified).toISOString()
  });
}

/**
 * Checks that a bucket exists and the credentials may use it.
 *
 * @param connection - The service.
 * @param bucket - The physical bucket name.
 * @throws {HolqaError} A classified failure; a missing bucket is `HOLQA_BINDING_FAILED`.
 */
export async function headBucket(connection: S3Connection, bucket: string): Promise<void> {
  const response = await send(connection, { method: "HEAD", bucket }, `checking the bucket "${bucket}"`);
  if (response.status === 404)
    throw new HolqaError(bindingFailure("failed", { binding: connection.binding, message: `The bucket "${bucket}" does not exist.`, hint: "Create it before starting, with your own tooling or a provisioning step; runtime credentials never create buckets.", details: { bucket } }));
  if (!response.ok)
    throw await failure(connection, response, `checking the bucket "${bucket}"`);
}

/**
 * Stores an object.
 *
 * @param connection - The service.
 * @param bucket - The physical bucket name.
 * @param key - Which object, unencoded.
 * @param body - The bytes.
 * @param contentType - The declared content type, if any.
 * @param trace - The writer's trace, stored as user metadata for event notifications.
 * @returns The stored object's metadata.
 */
export async function putObject(connection: S3Connection, bucket: string, key: string, body: Uint8Array, contentType: string | undefined, trace?: DeliveryTrace): Promise<ObjectMetadata> {
  const headers: Record<string, string> = contentType === undefined ? {} : { "content-type": contentType, [contentTypeMeta]: contentType };
  if (trace !== undefined)
    headers[traceMeta] = encodeURIComponent(JSON.stringify(trace));
  const response = await send(connection, { method: "PUT", bucket, key, body, headers }, `writing "${key}"`);
  if (!response.ok)
    throw await failure(connection, response, `writing "${key}"`);
  return metadataFrom(key, response, body.length, contentType);
}

/**
 * Reads an object.
 *
 * @param connection - The service.
 * @param bucket - The physical bucket name.
 * @param key - Which object, unencoded.
 * @returns The bytes, or `undefined` when there is no such object.
 */
export async function getObject(connection: S3Connection, bucket: string, key: string): Promise<Uint8Array | undefined> {
  const response = await send(connection, { method: "GET", bucket, key }, `reading "${key}"`);
  if (response.status === 404)
    return undefined;
  if (!response.ok)
    throw await failure(connection, response, `reading "${key}"`);
  return new Uint8Array(await response.arrayBuffer());
}

/**
 * Reads an object's metadata.
 *
 * @param connection - The service.
 * @param bucket - The physical bucket name.
 * @param key - Which object, unencoded.
 * @returns The metadata, or `undefined` when there is no such object.
 */
export async function headObject(connection: S3Connection, bucket: string, key: string): Promise<ObjectMetadata | undefined> {
  const response = await send(connection, { method: "HEAD", bucket, key }, `inspecting "${key}"`);
  if (response.status === 404)
    return undefined;
  if (!response.ok)
    throw await failure(connection, response, `inspecting "${key}"`);
  return metadataFrom(key, response);
}

/**
 * Deletes an object. S3 answers deletions of missing objects with success,
 * so existence is checked first; a concurrent writer can make the answer stale.
 *
 * @param connection - The service.
 * @param bucket - The physical bucket name.
 * @param key - Which object, unencoded.
 * @returns `false` when there was no such object.
 */
export async function deleteObject(connection: S3Connection, bucket: string, key: string): Promise<boolean> {
  if (await headObject(connection, bucket, key) === undefined)
    return false;
  const response = await send(connection, { method: "DELETE", bucket, key }, `deleting "${key}"`);
  if (!response.ok && response.status !== 404)
    throw await failure(connection, response, `deleting "${key}"`);
  return true;
}

/**
 * Decodes the XML entities S3 uses in listings.
 *
 * @param text - Element text.
 * @returns The decoded text.
 */
function xmlText(text: string): string {
  return text.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[\da-f]+);/gi, (_entity, name: string) => {
    switch (name.toLowerCase()) {
      case "lt": return "<";
      case "gt": return ">";
      case "amp": return "&";
      case "quot": return "\"";
      case "apos": return "'";
      default: return String.fromCodePoint(name.startsWith("#x") || name.startsWith("#X") ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10));
    }
  });
}

/**
 * Reads one element of an XML fragment.
 *
 * @param xml - The fragment.
 * @param name - The XML element whose text is read.
 * @returns Its decoded text, or `undefined`.
 */
function element(xml: string, name: string): string | undefined {
  const match = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml);
  return match === null ? undefined : xmlText(match[1]!);
}

/**
 * Lists objects with ListObjectsV2, in UTF-8 byte order, with keys URL-encoded
 * in transit so any key survives the XML.
 *
 * @param connection - The service.
 * @param bucket - The physical bucket name.
 * @param options - Prefix, cursor and page size.
 * @param options.prefix - Only keys with this prefix.
 * @param options.cursor - Where to continue.
 * @param options.limit - The page size, 1 to 1 000.
 * @returns The page.
 */
export async function listObjects(connection: S3Connection, bucket: string, options: { readonly prefix?: string; readonly cursor?: string; readonly limit: number }): Promise<ObjectList> {
  const query: Record<string, string> = {
    "list-type": "2",
    "max-keys": String(options.limit),
    "encoding-type": "url",
    ...options.prefix === undefined ? {} : { prefix: options.prefix },
    ...options.cursor === undefined ? {} : { "continuation-token": options.cursor }
  };
  const response = await send(connection, { method: "GET", bucket, query }, `listing "${bucket}"`);
  if (!response.ok)
    throw await failure(connection, response, `listing "${bucket}"`);
  const xml = await response.text();
  const objects = [...xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)].map(([, entry]) => Object.freeze({
    key: decodeURIComponent((element(entry!, "Key") ?? "").replaceAll("+", " ")),
    size: Number(element(entry!, "Size") ?? "0"),
    etag: (element(entry!, "ETag") ?? "").replaceAll("\"", ""),
    lastModified: new Date(element(entry!, "LastModified") ?? 0).toISOString()
  }));
  const truncated = element(xml, "IsTruncated") === "true";
  const next = element(xml, "NextContinuationToken");
  return Object.freeze({ objects: Object.freeze(objects), ...truncated && next !== undefined ? { cursor: next } : {} });
}

/**
 * Creates a presigned URL for reading or writing one object.
 *
 * @param connection - The service.
 * @param bucket - The physical bucket name.
 * @param key - Which object, unencoded.
 * @param options - Method, expiry and the content type an upload must declare.
 * @returns The signed URL.
 */
export function signObjectUrl(connection: S3Connection, bucket: string, key: string, options: SignedUrlOptions): SignedUrl {
  const now = connection.now?.() ?? new Date();
  const headers = options.method === "PUT" && options.contentType !== undefined ? { "content-type": options.contentType } : {};
  const url = presign({ method: options.method, url: objectUrl(connection, bucket, key), headers }, connection.credentials, { region: connection.region, service: "s3", date: now }, options.expiresInSeconds);
  return Object.freeze({ url: url.toString(), method: options.method, expiresAt: new Date(now.getTime() + options.expiresInSeconds * 1000).toISOString(), headers: Object.freeze(headers) });
}