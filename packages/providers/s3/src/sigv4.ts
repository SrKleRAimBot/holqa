import {
  createHash,
  createHmac
} from "node:crypto";

// AWS Signature Version 4, as S3-compatible services (AWS S3, MinIO, Ceph,
// Cloudflare R2, Backblaze B2, Garage, ...) verify it. Written directly
// against the specification so the provider needs no SDK.

/** The credentials requests are signed with. */
export interface SigningCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /** For temporary credentials. */
  readonly sessionToken?: string;
}

/** A request to sign. */
export interface SignableRequest {
  readonly method: string;
  readonly url: URL;
  /** Headers to sign, besides `host`, `x-amz-date` and `x-amz-content-sha256`. Names in any case. */
  readonly headers: Readonly<Record<string, string>>;
  /** The body's SHA-256 hex digest, or `UNSIGNED-PAYLOAD`. */
  readonly payloadHash: string;
}

/** Signed request headers: every header to send, including `host` and `authorization`. */
export type SignedHeaders = Readonly<Record<string, string>> & { readonly host: string; readonly authorization: string };

/** Where and when a request is signed. */
export interface SigningScope {
  readonly region: string;
  /** The service, `s3`. */
  readonly service: string;
  /** The signing time. */
  readonly date: Date;
}

/**
 * Returns the SHA-256 hex digest of bytes.
 *
 * @param data - The bytes or text.
 * @returns The lowercase hex digest.
 */
export function sha256Hex(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Encodes a string as SigV4 requires: every byte except `A-Z a-z 0-9 - _ . ~`
 * percent-encoded with uppercase hex; `/` kept when encoding a path.
 *
 * @param value - The string.
 * @param keepSlash - Whether `/` stays as is (paths) or is encoded (query values).
 * @returns The encoded string.
 */
export function uriEncode(value: string, keepSlash: boolean): string {
  let encoded = "";
  for (const byte of new TextEncoder().encode(value)) {
    const character = String.fromCharCode(byte);
    if (/[\w.~-]/.test(character) || (keepSlash && character === "/"))
      encoded += character;
    else
      encoded += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return encoded;
}

/**
 * Formats a time as SigV4's `YYYYMMDDTHHMMSSZ`.
 *
 * @param date - The time.
 * @returns The basic ISO 8601 form.
 */
export function amzDate(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/**
 * Derives the signing key of a day, region and service.
 *
 * @param secret - The secret access key.
 * @param scope - The region, service and date.
 * @returns The derived HMAC key for the day's scope.
 */
function signingKey(secret: string, scope: SigningScope): Buffer {
  const day = amzDate(scope.date).slice(0, 8);
  const dateKey = createHmac("sha256", `AWS4${secret}`).update(day).digest();
  const regionKey = createHmac("sha256", dateKey).update(scope.region).digest();
  const serviceKey = createHmac("sha256", regionKey).update(scope.service).digest();
  return createHmac("sha256", serviceKey).update("aws4_request").digest();
}

/**
 * Builds the canonical query string: parameters sorted by encoded name, then value.
 *
 * @param url - The URL whose query is canonicalized.
 * @returns The canonical query string.
 */
function canonicalQuery(url: URL): string {
  return [...url.searchParams.entries()]
    .map(([name, value]) => [uriEncode(name, false), uriEncode(value, false)] as const)
    .sort(([leftName, leftValue], [rightName, rightValue]) => leftName < rightName ? -1 : leftName > rightName ? 1 : leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0)
    .map(([name, value]) => `${name}=${value}`)
    .join("&");
}

/**
 * Computes the signature of a canonical request.
 *
 * @param request - The method, URL (already holding the canonical path), signed headers and payload hash.
 * @param signed - The headers to sign, lowercase names, including `host`.
 * @param credentials - The keys.
 * @param scope - The region, service and time.
 * @returns The signature, the signed header list and the credential scope.
 */
function signature(request: Pick<SignableRequest, "method" | "url" | "payloadHash">, signed: Readonly<Record<string, string>>, credentials: SigningCredentials, scope: SigningScope): { readonly signature: string; readonly signedHeaders: string; readonly credentialScope: string } {
  const names = Object.keys(signed).sort();
  const canonicalHeaders = names.map(name => `${name}:${signed[name]!.trim().replace(/\s+/g, " ")}\n`).join("");
  const signedHeaders = names.join(";");
  const canonicalRequest = [request.method, request.url.pathname, canonicalQuery(request.url), canonicalHeaders, signedHeaders, request.payloadHash].join("\n");
  const credentialScope = `${amzDate(scope.date).slice(0, 8)}/${scope.region}/${scope.service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate(scope.date), credentialScope, sha256Hex(canonicalRequest)].join("\n");
  return { signature: createHmac("sha256", signingKey(credentials.secretAccessKey, scope)).update(stringToSign).digest("hex"), signedHeaders, credentialScope };
}

/**
 * Signs a request with an `Authorization` header. The URL's path must
 * already be encoded as S3 expects (see {@link uriEncode}).
 *
 * @param request - Method, URL, extra headers and payload hash to sign.
 * @param credentials - The keys.
 * @param scope - The region, service and time.
 * @returns Every header to send, including `authorization`, `x-amz-date` and `x-amz-content-sha256`.
 */
export function signHeaders(request: SignableRequest, credentials: SigningCredentials, scope: SigningScope): SignedHeaders {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers))
    headers[name.toLowerCase()] = value;
  const signedHeaders: Record<string, string> = {
    ...headers,
    "host": request.url.host,
    "x-amz-date": amzDate(scope.date),
    "x-amz-content-sha256": request.payloadHash,
    ...credentials.sessionToken === undefined ? {} : { "x-amz-security-token": credentials.sessionToken }
  };
  const signed = signature(request, signedHeaders, credentials, scope);
  return { ...signedHeaders, host: request.url.host, authorization: `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${signed.credentialScope}, SignedHeaders=${signed.signedHeaders}, Signature=${signed.signature}` };
}

/**
 * Creates a presigned URL: the signature in the query, valid for
 * `expiresInSeconds` (at most 7 days), with an unsigned payload.
 *
 * @param request - The method, URL and headers the client must send (for example `content-type`).
 * @param credentials - The keys.
 * @param scope - The region, service and time.
 * @param expiresInSeconds - The validity, 1 to 604 800.
 * @returns The presigned URL.
 */
export function presign(request: Omit<SignableRequest, "payloadHash">, credentials: SigningCredentials, scope: SigningScope, expiresInSeconds: number): URL {
  const url = new URL(request.url);
  const headers: Record<string, string> = { host: url.host };
  for (const [name, value] of Object.entries(request.headers))
    headers[name.toLowerCase()] = value;
  const names = Object.keys(headers).sort();
  url.searchParams.set("X-Amz-Algorithm", "AWS4-HMAC-SHA256");
  url.searchParams.set("X-Amz-Credential", `${credentials.accessKeyId}/${amzDate(scope.date).slice(0, 8)}/${scope.region}/${scope.service}/aws4_request`);
  url.searchParams.set("X-Amz-Date", amzDate(scope.date));
  url.searchParams.set("X-Amz-Expires", String(expiresInSeconds));
  if (credentials.sessionToken !== undefined)
    url.searchParams.set("X-Amz-Security-Token", credentials.sessionToken);
  url.searchParams.set("X-Amz-SignedHeaders", names.join(";"));
  const signed = signature({ method: request.method, url, payloadHash: "UNSIGNED-PAYLOAD" }, headers, credentials, scope);
  url.searchParams.set("X-Amz-Signature", signed.signature);
  return url;
}