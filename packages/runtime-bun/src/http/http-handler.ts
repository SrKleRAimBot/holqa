import type { Dispatcher } from "@/dispatch/dispatcher";
import type { InvocationFailure } from "@/dispatch/failure";
import type { CorsPolicy } from "@/http/cors";
import type {
  RouteTable,
  RouteTransport
} from "@/http/router";
import type { StructuredLogger } from "@/logging/log";
import type { RuntimeTelemetry } from "@/telemetry/runtime-telemetry";
import type { ActiveSpan } from "@/telemetry/tracer";

import {
  diagnosticCodes,
  frameworkMetrics,
  isResponseLike,
  parseTraceparent,
  traceparentHeader,
  tracestateHeader
} from "@holqa/core";

import { runtimeFailure } from "@/dispatch/failure";
import { isPreflight } from "@/http/cors";
import { errorResponse } from "@/http/error-response";
import { matchRoute } from "@/http/router";
import { describeError } from "@/logging/log";

/** The header that carries a correlation identifier in and out. */
export const correlationHeader = "x-correlation-id";

/** Correlation identifiers accepted from callers: short and free of characters that could forge log lines. */
const correlationPattern = /^[\w.:-]{1,128}$/;

/** What the HTTP handler needs from its runtime. */
export interface HttpHandlerOptions {
  readonly table: RouteTable;
  readonly dispatcher: Dispatcher;
  readonly logger: StructuredLogger;
  readonly cors?: CorsPolicy;
  /** Whether to adopt a caller's `x-correlation-id`. When `false`, every request gets its invocation identifier. */
  readonly trustCorrelationHeader: boolean;
  /** Records server spans and request durations. */
  readonly telemetry: RuntimeTelemetry;
  /** A monotonic clock in milliseconds, for request durations. */
  readonly now: () => number;
  /**
   * Serves `GET` and `HEAD` requests that match no route from the
   * application's static sites. Resolves to `undefined` when no site has a
   * file for the request; routes always take precedence.
   */
  readonly staticSites?: (request: Request, pathname: string) => Promise<{ readonly response: Response; readonly route: string } | undefined>;
}

/** Methods recorded as themselves in metrics; anything else is `_OTHER`, as OpenTelemetry's HTTP conventions require, so callers cannot create series. */
const knownMethods: ReadonlySet<string> = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "CONNECT", "TRACE"]);

/** What the request handler reports back about the request it served. */
interface ServedRequest {
  /** The matched route template, for example `/api/orders/:orderId`. */
  route?: string;
}

/**
 * Creates the Fetch handler that serves an application's routes and
 * procedures: it matches the request, answers CORS preflights, dispatches
 * the matched handler through the common dispatcher, and encodes failures in
 * the transport's format. Unknown paths answer `404`, known paths with
 * another method `405` with an `allow` header, and malformed paths `400`.
 *
 * @param options - The route table, dispatcher, logger and HTTP settings.
 * @returns A function from `Request` to `Response`; it never rejects.
 */
export function createHttpHandler(options: HttpHandlerOptions): (request: Request) => Promise<Response> {
  const handle = createRequestHandler(options);
  const { telemetry } = options;
  return async (request) => {
    const started = options.now();
    const parent = telemetry.acceptTraceparent ? parseTraceparent(request.headers.get(traceparentHeader), request.headers.get(tracestateHeader)) : undefined;
    const method = knownMethods.has(request.method) ? request.method : "_OTHER";
    // The route template is recorded once matched; the concrete path is not,
    // because path segments often hold personal data (as object keys do).
    const span = telemetry.startSpan({
      name: method === "_OTHER" ? "HTTP" : method,
      kind: "server",
      ...parent === undefined ? {} : { parent },
      attributes: { "http.request.method": method, ...method === "_OTHER" ? { "http.request.method_original": request.method.slice(0, 32) } : {} }
    });
    const served: ServedRequest = {};
    let response: Response;
    try {
      response = await handle(request, span, served);
    } catch (error) {
      // Building a response can still fail (for example on headers a
      // foreign error object carries). Answer with a generic 500 instead of
      // letting the server render the error.
      options.logger.write("error", "the runtime failed to build a response", { error: describeError(error) });
      span?.recordException(error);
      response = errorResponse(runtimeFailure(diagnosticCodes.handlerFailed, "The request could not be handled."), "http", undefined);
    }
    const status = response.status;
    if (span !== undefined) {
      span.setAttribute("http.response.status_code", status);
      if (served.route !== undefined) {
        span.setAttribute("http.route", served.route);
        span.updateName(`${method === "_OTHER" ? "HTTP" : method} ${served.route}`);
      }
      // OpenTelemetry's HTTP conventions: a 4xx is the caller's error, not the server's.
      if (status >= 500)
        span.setStatus({ code: "error", message: `HTTP ${status}` });
      span.end();
    }
    telemetry.record(frameworkMetrics.httpServerDuration, (options.now() - started) / 1000, { "http.request.method": method, "http.response.status_code": status, ...served.route === undefined ? {} : { "http.route": served.route } });
    return response;
  };
}

/**
 * Creates the request handler without the final safety net.
 *
 * @param options - The route table, dispatcher, logger and HTTP settings.
 * @returns A function from `Request` (with the request's server span and a record of what was served) to `Response` that may reject on internal errors.
 */
function createRequestHandler(options: HttpHandlerOptions): (request: Request, span: ActiveSpan | undefined, served: ServedRequest) => Promise<Response> {
  const { table, dispatcher, logger, cors } = options;
  return async (request, span, served) => {
    const url = new URL(request.url);
    const offered = request.headers.get(correlationHeader);
    const correlationId = options.trustCorrelationHeader && offered !== null && correlationPattern.test(offered) ? offered : undefined;
    const corsHeaders = cors?.responseHeaders(request.headers.get("origin")) ?? {};
    const match = matchRoute(table, request.method, url.pathname);

    /**
     * Answers without an invocation, for requests that match no handler.
     *
     * @param failure - Why the request was not dispatched.
     * @param transport - The format of the error body.
     * @returns The error response.
     */
    const reject = (failure: InvocationFailure, transport: RouteTransport): Response => {
      logger.write("info", "request rejected", { code: failure.code, method: request.method, path: url.pathname });
      return finalize(errorResponse(failure, transport, undefined), request, { ...corsHeaders, ...correlationId === undefined ? {} : { [correlationHeader]: correlationId } });
    };

    if (request.method === "OPTIONS" && match.kind === "method-not-allowed") {
      if (cors !== undefined && isPreflight(request))
        return new Response(null, { status: 204, headers: cors.preflightHeaders(request, match.allowed) });
      return new Response(null, { status: 204, headers: { ...corsHeaders, allow: [...match.allowed, "OPTIONS"].join(", ") } });
    }
    if (match.kind === "malformed")
      return reject(runtimeFailure(diagnosticCodes.inputInvalid, "The request path is not valid percent-encoding.", {}, 400), match.transport);
    if (match.kind === "not-found") {
      if ((request.method === "GET" || request.method === "HEAD") && options.staticSites !== undefined) {
        const site = await options.staticSites(request, url.pathname);
        if (site !== undefined) {
          served.route = site.route;
          return site.response;
        }
      }
      return reject(runtimeFailure(diagnosticCodes.httpRouteNotFound, `No route or procedure serves ${url.pathname}.`), match.transport);
    }
    if (match.kind === "method-not-allowed")
      return reject(runtimeFailure(diagnosticCodes.httpMethodNotAllowed, `${request.method} is not allowed for ${url.pathname}.`, { allow: match.allowed.join(", ") }), match.transport);

    served.route = match.entry.path;
    const outcome = await dispatcher.dispatch({
      handlerId: match.entry.handlerId,
      input: Object.freeze({ request, params: match.params }),
      signal: request.signal,
      ...correlationId === undefined ? {} : { correlationId },
      logFields: { method: request.method, path: url.pathname }
    }, span === undefined ? {} : { span });
    const headers = { ...corsHeaders, [correlationHeader]: outcome.correlationId };
    if (!outcome.ok)
      return finalize(errorResponse(outcome.failure, match.entry.transport, outcome.invocationId), request, headers);
    if (!isResponseLike(outcome.value)) {
      logger.write("error", "a handler resolved to something that is not a Response", { handlerId: outcome.handlerId, invocationId: outcome.invocationId });
      return finalize(errorResponse(runtimeFailure(diagnosticCodes.responseInvalid, "The handler produced a response that does not match its contract."), match.entry.transport, outcome.invocationId), request, headers);
    }
    return finalize(outcome.value, request, headers);
  };
}

/**
 * Adds headers to a response and drops the body of `HEAD` responses. The
 * response is rebuilt, because handler responses may have immutable headers;
 * a streaming body is passed through unread.
 *
 * @param response - The handler's or the runtime's response.
 * @param request - The request it answers.
 * @param extra - Headers to set.
 * @returns The response to send.
 */
function finalize(response: Response, request: Request, extra: Readonly<Record<string, string>>): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(extra))
    headers.set(name, value);
  if (request.method === "HEAD") {
    // Release a body that will never be read, for example a stream. A failure
    // to cancel is deliberately ignored: the body is discarded either way, and
    // the response to the HEAD request does not depend on it.
    void response.body?.cancel().catch(() => undefined);
    return new Response(null, { status: response.status, statusText: response.statusText, headers });
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}