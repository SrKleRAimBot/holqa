import type {
  ApplicationScope,
  HandlerInvoke,
  HttpMethod,
  InferInput,
  InferOutput,
  InvocationLogger,
  InvocationTelemetry,
  ResourceId,
  StandardSchemaV1
} from "@holqa/core";

import type {
  AnyHttpMiddleware,
  CheckMiddlewareChain,
  MiddlewareChainContext
} from "@/http/middleware";
import type {
  HeaderRecord,
  QueryRecord
} from "@/http/request";
import type { HandlerEventOptions } from "@/internal/event-options";
import type { HandlerRegistration } from "@/resources/handle";

import type { HolqaTypeError } from "@/types/checks";
import {
  descriptorKey,
  descriptorProtocol,
  isResponseLike,
  validateInput
} from "@holqa/core";

import { middlewareList } from "@/http/middleware";
import { runHttpPipeline } from "@/http/pipeline";
import {
  readHeaders,
  readJsonBody,
  readQuery,
  readRequestPart
} from "@/http/request";
import {
  encodeContractValue,
  jsonResponse,
  responseInvalid
} from "@/http/response";
import {
  DeclarationProblems,
  definedEntries,
  freezeJson,
  requireOptions
} from "@/internal/declaration";
import { readEventOptions } from "@/internal/event-options";

/** Methods that must not declare a request body. */
export type BodylessMethod = "GET" | "DELETE";

/** The parameter names in a path template, for example `"orderId"` for `/orders/:orderId`. */
export type PathParamNames<Path extends string> = Path extends `${string}:${infer Param}/${infer Rest}`
  ? Param | PathParamNames<`/${Rest}`>
  : Path extends `${string}:${infer Param}` ? Param : never;

/** Path parameters inferred from a template when no `params` schema is declared. */
export type PathParams<Path extends string> = { readonly [Name in PathParamNames<Path>]: string };

/** Response schemas keyed by HTTP status code. */
export type ResponseSchemas = Readonly<{ [status: number]: StandardSchemaV1 }>;

/**
 * A declared response built by `reply`: one variant per declared status, with
 * the body in that status schema's input form (it is validated and sent in its output form).
 *
 * @typeParam Responses - The route's response schemas.
 */
export type RouteReplyValue<Responses extends ResponseSchemas> = {
  readonly [Status in keyof Responses & number]: {
    readonly "~holqa.reply": 1;
    readonly "status": Status;
    readonly "body": InferInput<Responses[Status]>;
    readonly "headers"?: Readonly<Record<string, string>>;
  }
}[keyof Responses & number];

/**
 * Builds one of a route's declared responses. Calling `reply(200, body)`
 * instead of returning `{ status: 200, body }` keeps the status and body
 * literals precise: TypeScript widens literals in a returned object literal
 * whose contextual type depends on a type parameter of the same call, but it
 * checks the arguments of `reply` against the already inferred `responses`
 * (ADR 0012).
 *
 * @typeParam Responses - The route's response schemas.
 */
export type RouteReply<Responses extends ResponseSchemas> = (...args: {
  // One parameter list per status, so a status union cannot pair with another status's body.
  [Status in keyof Responses & number]: [status: Status, body: InferInput<Responses[Status]>, headers?: Readonly<Record<string, string>>]
}[keyof Responses & number]) => RouteReplyValue<Responses>;

/**
 * What a route handler may return: a declared reply, or a `Response` it built
 * itself (for streaming or non-JSON bodies). A `Response`'s status must be
 * declared, but its body is not validated.
 *
 * @typeParam Responses - The route's response schemas.
 */
export type RouteResult<Responses extends ResponseSchemas> = RouteReplyValue<Responses> | Response;

/** The validated type of an optional schema, or a fallback when it is absent. */
type Validated<Schema, Fallback> = Schema extends StandardSchemaV1 ? InferOutput<Schema> : Fallback;

/** The client-side type of an optional schema, or a fallback when it is absent. */
type Sent<Schema, Fallback> = Schema extends StandardSchemaV1 ? InferInput<Schema> : Fallback;

/**
 * What a route handler receives. `params`, `query`, `headers` and `body` are
 * validated against their schemas before the handler runs; without a schema
 * they hold the raw values (and `body` is `undefined`, leaving
 * `request.body` unread for streaming).
 */
export interface RouteContext<Path extends string, Params, Query, Body, Headers, Responses extends ResponseSchemas, Context extends object> {
  readonly params: Validated<Params, PathParams<Path>>;
  readonly query: Validated<Query, QueryRecord>;
  readonly headers: Validated<Headers, HeaderRecord>;
  readonly body: Validated<Body, undefined>;
  /** The typed context added by middleware. */
  readonly context: Readonly<Context>;
  readonly request: Request;
  readonly url: URL;
  readonly invocationId: string;
  readonly correlationId: string;
  readonly signal: AbortSignal;
  readonly log: InvocationLogger;
  /** The invocation's telemetry trace context, for example to pass a `traceparent` header to an outgoing call. Absent when the runtime records no telemetry. */
  readonly telemetry?: InvocationTelemetry;
  readonly scope: ApplicationScope;
  readonly reply: RouteReply<Responses>;
}

/**
 * Resolves to `unknown` when a `params` schema declares exactly the path's
 * parameters, and to a readable error type otherwise.
 */
export type CheckParams<Path extends string, Params> = Params extends StandardSchemaV1
  ? [Exclude<keyof InferOutput<Params>, PathParamNames<Path>> | Exclude<PathParamNames<Path>, keyof InferOutput<Params>>] extends [never]
    ? PathParams<Path> extends InferInput<Params>
      ? unknown
      : HolqaTypeError<`Path parameters arrive as strings; the params schema of "${Path}" must accept strings (coerce them, for example z.coerce.number()).`>
    : HolqaTypeError<`The params schema must declare exactly the parameters in "${Path}".`>
  : unknown;

/**
 * Options accepted by {@link HttpApiHandle.route}.
 *
 * @typeParam Context - The context the API's middleware provides.
 */
export interface RouteOptions<
  HandlerId extends string,
  Method extends HttpMethod,
  Path extends string,
  Params extends StandardSchemaV1 | undefined,
  Query extends StandardSchemaV1 | undefined,
  Body extends StandardSchemaV1 | undefined,
  Headers extends StandardSchemaV1 | undefined,
  Responses extends ResponseSchemas,
  Middleware extends readonly AnyHttpMiddleware[],
  Context extends object
> {
  /** The route's persistent identity. */
  readonly id: HandlerId;
  readonly method: Method;
  /** Path relative to the API's base path. `:name` segments are parameters. */
  readonly path: Path;
  readonly params?: Params & CheckParams<Path, Params>;
  readonly query?: Query;
  /** Request headers, as a record of lowercase names. */
  readonly headers?: Headers;
  /** The JSON request body. Not allowed for GET and DELETE. */
  readonly body?: [Extract<Method, BodylessMethod>] extends [never] ? Body : never;
  /** Response schemas keyed by status. Only these statuses may be returned. */
  readonly responses: Responses;
  /** Middleware for this route only; it runs after application and API middleware. */
  readonly middleware?: Middleware & CheckMiddlewareChain<Context, Middleware>;
  /**
   * The implementation. Return `context.reply(status, body)`, or a
   * `Response` for streaming. `NoInfer` keeps the return value from
   * influencing inference of `responses`.
   */
  readonly handler: (context: RouteContext<Path, Params, Query, Body, Headers, Responses, MiddlewareChainContext<Context, Middleware>>) => NoInfer<RouteResult<Responses> | Promise<RouteResult<Responses>>>;
  /** Event safety declarations: publications analysis cannot see, and the publication limit. */
  readonly events?: HandlerEventOptions;
}

/**
 * The client-facing contract of a route: what a caller sends and what it
 * receives. Usable through `import type` without bundling server code.
 */
export interface RouteContract<Method extends HttpMethod, Path extends string, Params, Query, Body, Headers, Responses extends ResponseSchemas> {
  readonly method: Method;
  readonly path: Path;
  readonly params: Sent<Params, PathParams<Path>>;
  readonly query: Sent<Query, QueryRecord | undefined>;
  readonly headers: Sent<Headers, HeaderRecord | undefined>;
  readonly body: Sent<Body, undefined>;
  readonly response: {
    readonly [Status in keyof Responses & number]: { readonly status: Status; readonly body: InferOutput<Responses[Status]> }
  }[keyof Responses & number];
}

/**
 * A registered HTTP route. Export it from a handler module.
 *
 * @typeParam ApiId - The API's identifier.
 * @typeParam HandlerId - The route's identifier.
 * @typeParam Contract - The route's client-facing contract.
 */
export interface HttpRoute<ApiId extends string, HandlerId extends string, Contract> extends HandlerRegistration<"http.route", HandlerId, ApiId> {
  /** Phantom type carrier for client contracts; never present at run time. */
  readonly "~contract"?: Contract;
}

/** The client-facing contract of a route registration. */
export type InferRouteContract<Route> = Route extends { readonly "~contract"?: infer Contract } ? NonNullable<Contract> : never;

/** The methods a route may declare. */
const routeMethods: readonly HttpMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE"];

/** A route path: `/`, or literal and `:name` segments without a trailing `/`. */
const routePathPattern = /^\/$|^(?:\/(?:[\w.~-]+|:[a-z_]\w*))+$/i;

/** What an API handle hands to {@link createRoute}. */
export interface RouteHost {
  readonly apiId: ResourceId;
  /** Returns the middleware to run before the route's own: the application's, then the API's. */
  readonly middleware: () => readonly AnyHttpMiddleware[];
}

/** The untyped view of route options used at run time. */
interface RuntimeRouteOptions {
  readonly id: string;
  readonly method: HttpMethod;
  readonly path: string;
  readonly params?: StandardSchemaV1;
  readonly query?: StandardSchemaV1;
  readonly headers?: StandardSchemaV1;
  readonly body?: StandardSchemaV1;
  readonly responses: Readonly<Record<number, StandardSchemaV1>>;
  readonly middleware?: readonly AnyHttpMiddleware[];
  readonly handler: (context: never) => unknown;
  readonly events?: HandlerEventOptions;
}

/**
 * Validates a route declaration and builds its registration: JSON metadata a
 * compiler can read, its schemas by role, and the `invoke` function a
 * runtime calls with `{ request, params }`.
 *
 * @param host - The API the route belongs to.
 * @param options - The route declaration.
 * @returns The frozen registration.
 * @throws {HolqaError} `HOLQA_RESOURCE_ID_INVALID` or `HOLQA_DECLARATION_INVALID` for a malformed declaration.
 */
export function createRoute(host: RouteHost, options: RuntimeRouteOptions): HttpRoute<string, string, unknown> {
  const raw = requireOptions(options, `route of http.api "${host.apiId}"`);
  const problems = new DeclarationProblems(`route "${String(raw.id)}" of http.api "${host.apiId}"`);
  const idCandidate = problems.identifier(raw.id, "route id");
  problems.oneOf(raw.method, routeMethods, "method");
  if (typeof raw.path !== "string" || !routePathPattern.test(raw.path))
    problems.invalid("\"path\" must be \"/\" or a path such as \"/orders/:orderId\" without a trailing \"/\".");
  const parameterNames = typeof raw.path === "string" ? raw.path.split("/").filter(segment => segment.startsWith(":")).map(segment => segment.slice(1)) : [];
  if (new Set(parameterNames).size !== parameterNames.length)
    problems.invalid("\"path\" declares a parameter more than once.");
  for (const role of ["params", "query", "headers", "body"] as const) {
    if (raw[role] !== undefined)
      problems.schema(raw[role], role);
  }
  if (raw.body !== undefined && (raw.method === "GET" || raw.method === "DELETE"))
    problems.invalid(`"body" is not allowed for ${String(raw.method)} routes.`);
  const responses = responseSchemas(raw.responses, problems);
  const ownMiddleware = middlewareList(raw.middleware, problems);
  if (typeof raw.handler !== "function")
    problems.invalid("\"handler\" must be a function.");
  const events = readEventOptions(raw.events, problems);
  const id = problems.valid(idCandidate);
  const subject = `${options.method} ${options.path} (route "${id}")`;

  /**
   * Runs the middleware chain, validates the request parts, calls the handler
   * and checks its response against the declared contract.
   *
   * @param input - The untrusted `{ request, params }` from the runtime.
   * @param context - The invocation context.
   * @returns The response.
   */
  const invoke: HandlerInvoke<"http.route"> = async (input, context) => runHttpPipeline(input, context, [...host.middleware(), ...ownMiddleware], async (args) => {
    const parts = await readRequestPart(async () => ({
      params: options.params === undefined ? args.params : await validateInput(options.params, args.params, `path parameters of ${subject}`),
      query: options.query === undefined ? readQuery(args.url) : await validateInput(options.query, readQuery(args.url), `query of ${subject}`),
      headers: options.headers === undefined ? readHeaders(args.request.headers) : await validateInput(options.headers, readHeaders(args.request.headers), `headers of ${subject}`),
      body: options.body === undefined ? undefined : await validateInput(options.body, await readJsonBody(args.request, `body of ${subject}`), `body of ${subject}`)
    }));
    const result: unknown = await options.handler({ ...args, ...parts, reply } as never);
    return toResponse(result, responses, subject);
  });

  return Object.freeze({
    [descriptorKey]: Object.freeze({
      protocol: descriptorProtocol,
      type: "handler" as const,
      definition: freezeJson({
        id,
        trigger: { kind: "http.route" as const, resource: { kind: "http.api" as const, id: host.apiId }, options: { method: options.method, path: options.path } },
        ...definedEntries({ events })
      }),
      schemas: Object.freeze({ ...definedEntries({ params: options.params, query: options.query, headers: options.headers, body: options.body }), responses }),
      invoke
    }),
    trigger: "http.route" as const,
    id: options.id,
    resourceId: host.apiId
  });
}

/**
 * Builds a reply value. The status and body are checked when the handler returns it.
 *
 * @param status - A declared status.
 * @param body - The body in the status schema's input form; it is validated and sent in its output form.
 * @param headers - Extra response headers.
 * @returns The reply value.
 */
function reply(status: number, body: unknown, headers?: Readonly<Record<string, string>>): { readonly "~holqa.reply": 1; readonly "status": number; readonly "body": unknown; readonly "headers"?: Readonly<Record<string, string>> } {
  return Object.freeze({ "~holqa.reply": 1 as const, status, body, ...headers === undefined ? {} : { headers: Object.freeze({ ...headers }) } });
}

/**
 * Checks a handler's return value against the declared responses and turns it into a `Response`.
 *
 * @param result - What the handler returned.
 * @param responses - The declared response schemas.
 * @param subject - The route, for messages.
 * @returns The response to send.
 * @throws {HolqaError} `HOLQA_RESPONSE_INVALID` for an undeclared status, a body its schema rejects, or a value that is neither a reply nor a `Response`.
 */
async function toResponse(result: unknown, responses: Readonly<Record<number, StandardSchemaV1>>, subject: string): Promise<Response> {
  if (isResponseLike(result)) {
    if (responses[result.status] === undefined)
      throw responseInvalid(`The ${subject} returned status ${result.status}, which it does not declare.`, undefined, { status: result.status });
    return result;
  }
  if (typeof result !== "object" || result === null || !("~holqa.reply" in result) || !("status" in result) || typeof result.status !== "number")
    throw responseInvalid(`The ${subject} returned neither reply(...) nor a Response.`);
  const { status } = result;
  const schema = responses[status];
  if (schema === undefined)
    throw responseInvalid(`The ${subject} replied with status ${status}, which it does not declare.`, undefined, { status });
  const body = "body" in result ? result.body : undefined;
  const headers = "headers" in result ? result.headers as Readonly<Record<string, string>> : undefined;
  let payload;
  try {
    payload = await encodeContractValue(schema, body, `${status} response of ${subject}`);
  } catch (error) {
    throw responseInvalid(`The ${status} response body of ${subject} does not match its schema.`, error, { status });
  }
  return jsonResponse(status, payload, headers, `${status} response of ${subject}`);
}

/**
 * Checks the `responses` record: at least one status, each a valid HTTP
 * status with a Standard Schema.
 *
 * @param value - The declared responses, unvalidated.
 * @param problems - Where to record problems.
 * @returns A frozen copy keyed by status.
 */
function responseSchemas(value: unknown, problems: DeclarationProblems): Readonly<Record<number, StandardSchemaV1>> {
  if (typeof value !== "object" || value === null || Array.isArray(value) || Object.keys(value).length === 0) {
    problems.invalid("\"responses\" must declare at least one status, for example { 200: schema }.");
    return Object.freeze({});
  }
  const schemas: Record<number, StandardSchemaV1> = {};
  for (const [status, schema] of Object.entries(value as Readonly<Record<string, unknown>>)) {
    if (!/^[1-5]\d\d$/.test(status)) {
      problems.invalid(`"responses.${status}" is not an HTTP status between 100 and 599.`);
      continue;
    }
    problems.schema(schema, `responses.${status}`);
    schemas[Number(status)] = schema as StandardSchemaV1;
  }
  return Object.freeze(schemas);
}