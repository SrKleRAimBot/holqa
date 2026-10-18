import type {
  HttpErrorBody,
  HttpErrorDetail,
  RpcFailureEnvelope
} from "@holqa/core";

import type { InvocationFailure } from "@/dispatch/failure";
import type { RouteTransport } from "@/http/router";

import {
  jsonPayloadMediaType,
  rpcProtocolFormat
} from "@holqa/core";

/**
 * Builds the error object sent to callers from a normalized failure: its
 * code, safe message, validation issues and the invocation identifier.
 *
 * @param failure - The normalized failure.
 * @param invocationId - The failed invocation, when one started.
 * @returns The `error` object of a route error body or RPC failure envelope.
 */
export function errorDetail(failure: InvocationFailure, invocationId: string | undefined): HttpErrorDetail {
  return {
    code: failure.code,
    message: failure.message,
    ...invocationId === undefined ? {} : { invocationId },
    ...failure.issues.length === 0 ? {} : { issues: failure.issues }
  };
}

/**
 * Turns a failure into an HTTP response in the transport's format: a route
 * error body `{ "error": ... }`, or a `holqa.rpc/1` failure envelope.
 *
 * @param failure - The normalized failure.
 * @param transport - Whether the request targeted a route or a procedure.
 * @param invocationId - The failed invocation, when one started.
 * @returns A JSON response with the failure's status and headers.
 */
export function errorResponse(failure: InvocationFailure, transport: RouteTransport, invocationId: string | undefined): Response {
  const error = errorDetail(failure, invocationId);
  const body: HttpErrorBody | RpcFailureEnvelope = transport === "rpc" ? { format: rpcProtocolFormat, ok: false, error } : { error };
  return new Response(JSON.stringify(body), {
    status: failure.status,
    headers: { ...failure.headers, "content-type": `${jsonPayloadMediaType}; charset=utf-8` }
  });
}