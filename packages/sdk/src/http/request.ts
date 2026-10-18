import type { JsonValue } from "@holqa/core";

import {
  decodeJsonPayload,
  diagnosticCodes,
  failWith,
  HttpRejectedError,
  isHolqaError
} from "@holqa/core";

/** Query parameters: one string per name, or every value in order when the name repeats. */
export type QueryRecord = Readonly<Record<string, string | readonly string[]>>;

/** Request headers by lowercase name; repeated headers are joined with `, ` as the Fetch API does. */
export type HeaderRecord = Readonly<Record<string, string>>;

/** `application/json`, or a structured syntax suffix such as `application/problem+json`, with optional parameters. */
const jsonMediaType = /^application\/(?:[\w.+-]+\+)?json\s*(?:;|$)/i;

/**
 * Reads the query string into a record. Built with `Object.fromEntries`, so a
 * parameter named `__proto__` is an ordinary property, never a prototype.
 *
 * @param url - The request URL.
 * @returns The parameters by name, frozen.
 */
export function readQuery(url: URL): QueryRecord {
  const values = new Map<string, string[]>();
  for (const [name, value] of url.searchParams)
    values.set(name, [...values.get(name) ?? [], value]);
  return Object.freeze(Object.fromEntries([...values].map(([name, list]) => [name, list.length === 1 ? list[0]! : Object.freeze(list)])));
}

/**
 * Reads request headers into a record.
 *
 * @param headers - The request headers.
 * @returns The headers by lowercase name, frozen.
 */
export function readHeaders(headers: Headers): HeaderRecord {
  return Object.freeze(Object.fromEntries(headers.entries()));
}

/**
 * Reports whether a request declares a JSON body.
 *
 * @param request - The incoming request whose `content-type` header is inspected.
 * @returns `true` when its `content-type` is JSON.
 */
export function hasJsonContentType(request: Request): boolean {
  return jsonMediaType.test(request.headers.get("content-type") ?? "");
}

/**
 * Reads a JSON request body. An empty body reads as `undefined`, so a schema
 * decides whether a body is required.
 *
 * @param request - The request whose body to read.
 * @param subject - What is being read, for messages, for example `body of POST /orders`.
 * @returns The decoded JSON value, or `undefined` for an empty body.
 * @throws {HolqaError} `HOLQA_HTTP_MEDIA_TYPE_UNSUPPORTED` for a non-empty body that is not declared as JSON, or `HOLQA_PAYLOAD_MALFORMED` for malformed JSON.
 */
export async function readJsonBody(request: Request, subject: string): Promise<JsonValue | undefined> {
  const text = await request.text();
  if (text === "")
    return undefined;
  if (!hasJsonContentType(request))
    failWith(diagnosticCodes.httpMediaTypeUnsupported, `The ${subject} must be sent as application/json.`, "Send the body with content-type: application/json.");
  return decodeJsonPayload(text, subject);
}

/**
 * Reads and validates the caller's part of a request, marking every Holqa
 * error it raises as the caller's fault: it becomes an
 * {@link HttpRejectedError} that keeps the original code (`415` for an
 * unsupported media type, `400` otherwise). Errors raised later, by the
 * handler itself, are therefore never mistaken for bad requests.
 *
 * @param read - Reads and validates request parts.
 * @returns What `read` returns.
 * @throws {HttpRejectedError} Wrapping any Holqa error `read` throws; other errors are rethrown unchanged.
 */
export async function readRequestPart<Value>(read: () => Promise<Value>): Promise<Value> {
  try {
    return await read();
  } catch (error) {
    if (!isHolqaError(error))
      throw error;
    const status = error.code === diagnosticCodes.httpMediaTypeUnsupported ? 415 : 400;
    throw new HttpRejectedError(status, error.diagnostics[0]!.message, { cause: error });
  }
}