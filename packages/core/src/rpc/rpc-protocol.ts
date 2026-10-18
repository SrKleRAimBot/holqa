import type { HttpErrorDetail } from "@/http/http-error";
import type { JsonValue } from "@/json";

/**
 * The format tag of version 1 of Holqa's RPC wire protocol. It is Holqa's own
 * protocol and is not compatible with JSON-RPC 2.0.
 */
export const rpcProtocolFormat = "holqa.rpc/1";

/** The protocol version a client may request with {@link rpcVersionHeader}. */
export const rpcProtocolVersion = "1";

/**
 * The request header a client may send to pin the protocol version. A
 * runtime that does not implement the requested version rejects the call
 * with `HOLQA_RPC_VERSION_UNSUPPORTED` instead of guessing.
 */
export const rpcVersionHeader = "holqa-rpc-version";

/** The path segment under an API's base path where procedures are mounted. */
export const rpcMountSegment = "rpc";

/** The query parameter that carries the JSON-encoded input of a query called with `GET`. */
export const rpcInputQueryParameter = "input";

/**
 * The body of a `POST` call: the procedure's input in its schema's input
 * (wire) form. `input` is omitted for procedures without input.
 */
export interface RpcRequestEnvelope {
  readonly input?: JsonValue;
}

/**
 * A successful call. `output` is the procedure's result after validation,
 * in its output schema's output form, as a JSON copy; it is omitted when the
 * validated output is `undefined`.
 *
 * @typeParam Output - The wire type of the output.
 */
export interface RpcSuccessEnvelope<Output = JsonValue> {
  readonly format: typeof rpcProtocolFormat;
  readonly ok: true;
  readonly output?: Output;
}

/** A failed call. The HTTP status is set to match `error.code`. */
export interface RpcFailureEnvelope {
  readonly format: typeof rpcProtocolFormat;
  readonly ok: false;
  readonly error: HttpErrorDetail;
}

/**
 * Every response body of an RPC call, discriminated by `ok`.
 *
 * @typeParam Output - The wire type of a successful call's output.
 */
export type RpcResponseEnvelope<Output = JsonValue> = RpcSuccessEnvelope<Output> | RpcFailureEnvelope;

/**
 * Builds the path a procedure is served at: the API's base path, the RPC
 * mount segment and the procedure's identifier, for example
 * `/api/rpc/orders.get`. Procedure identifiers follow the resource identifier
 * grammar, so they never need escaping.
 *
 * @param basePath - The API's base path, `/` or a path such as `/api`.
 * @param procedureId - The procedure's handler identifier.
 * @returns The absolute path of the procedure.
 */
export function rpcProcedurePath(basePath: string, procedureId: string): string {
  const prefix = basePath === "/" ? "" : basePath;
  return `${prefix}/${rpcMountSegment}/${procedureId}`;
}