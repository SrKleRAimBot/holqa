import type {
  Described,
  HandlerDescriptor,
  InferInput,
  InferOutput,
  InvocationLogger,
  JsonObject,
  ResourceDescriptor,
  StandardSchemaV1
} from "@holqa/experiment-model";

import {
  descriptorKey,
  experimentCodes,
  fail,
  validateInput
} from "@holqa/experiment-model";

import {
  definedEntries,
  handlerDescriptor,
  resourceDescriptor
} from "@/internal/describe";

/** HTTP methods a route may declare. */
export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** Methods that must not declare a request body. */
export type BodylessMethod = "GET" | "DELETE";

/** The parameter names in a route path template, for example `"orderId"` for `/orders/:orderId`. */
export type PathParamNames<Path extends string> = Path extends `${string}:${infer Param}/${infer Rest}`
  ? Param | PathParamNames<`/${Rest}`>
  : Path extends `${string}:${infer Param}` ? Param : never;

/** Raw path parameters inferred from a path template when no `params` schema is declared. */
export type PathParams<Path extends string> = { readonly [Name in PathParamNames<Path>]: string };

/** Response schemas keyed by HTTP status code. */
export type ResponseSchemas = Readonly<{ [status: number]: StandardSchemaV1 }>;

/** The union of responses a route handler may return: one variant per declared status. */
export type RouteResponse<Responses extends ResponseSchemas> = {
  [Status in keyof Responses & number]: {
    readonly status: Status;
    readonly body: Responses[Status] extends StandardSchemaV1 ? InferInput<Responses[Status]> : never;
    readonly headers?: Readonly<Record<string, string>>;
  }
}[keyof Responses & number];

/**
 * Resolves to `unknown` when a `params` schema declares exactly the path's
 * parameters, and to a readable error type otherwise.
 */
export type ParamsMatchPath<Path extends string, Params> = Params extends StandardSchemaV1
  ? [Exclude<keyof InferOutput<Params>, PathParamNames<Path>> | Exclude<PathParamNames<Path>, keyof InferOutput<Params>>] extends [never]
    ? unknown
    : { readonly "~error": `The params schema must declare exactly the parameters in "${Path}".` }
  : unknown;

/**
 * Builds one of a route's declared responses. Calling `reply(200, body)`
 * instead of returning `{ status: 200, body }` is what keeps the status and
 * body literals precise: TypeScript widens literals in a returned object
 * literal whose contextual type depends on a type parameter of the same call
 * (`200` becomes `number`), but it checks the arguments of `reply` against the
 * already-inferred `responses`.
 */
export type RouteReply<Responses extends ResponseSchemas> = <Status extends keyof Responses & number>(
  status: Status,
  body: Responses[Status] extends StandardSchemaV1 ? InferInput<Responses[Status]> : never,
  headers?: Readonly<Record<string, string>>
) => RouteResponse<Responses>;

/** What a route handler receives. Every part is validated before the handler runs. */
export interface RouteContext<Path extends string, Params, Query, Body, Responses extends ResponseSchemas = ResponseSchemas> {
  readonly params: Params extends StandardSchemaV1 ? InferOutput<Params> : PathParams<Path>;
  readonly query: Query extends StandardSchemaV1 ? InferOutput<Query> : Readonly<Record<string, string>>;
  readonly body: Body extends StandardSchemaV1 ? InferOutput<Body> : undefined;
  readonly headers: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
  readonly log: InvocationLogger;
  /** Builds a declared response; see {@link RouteReply}. */
  readonly reply: RouteReply<Responses>;
}

/** Options accepted by {@link HttpApiHandle.route}. */
export interface RouteOptions<
  HandlerId extends string,
  Method extends HttpMethod,
  Path extends string,
  Params extends StandardSchemaV1 | undefined,
  Query extends StandardSchemaV1 | undefined,
  Body extends StandardSchemaV1 | undefined,
  Responses extends ResponseSchemas
> {
  readonly id: HandlerId;
  readonly method: Method;
  /** Path relative to the API's base path. `:name` segments are parameters. */
  readonly path: Path;
  readonly params?: Params & ParamsMatchPath<Path, Params>;
  readonly query?: Query;
  /** Request body schema. Not allowed for GET and DELETE. */
  readonly body?: Method extends BodylessMethod ? never : Body;
  readonly responses: Responses;
  /**
   * The route's implementation. Return `context.reply(status, body)`; see
   * {@link RouteReply} for why a returned object literal is not enough.
   * `NoInfer` keeps the return value from influencing inference of `responses`.
   */
  readonly handler: (context: RouteContext<Path, Params, Query, Body, Responses>) => NoInfer<Promise<RouteResponse<Responses>> | RouteResponse<Responses>>;
}

/**
 * The public contract of a route, derived from its declaration: what a client
 * sends and what it receives. Usable through `import type` without bundling
 * server code.
 */
export interface RouteContract<Method extends HttpMethod, Path extends string, Params, Query, Body, Responses extends ResponseSchemas> {
  readonly method: Method;
  readonly path: Path;
  readonly params: Params extends StandardSchemaV1 ? InferInput<Params> : PathParams<Path>;
  readonly query: Query extends StandardSchemaV1 ? InferInput<Query> : undefined;
  readonly body: Body extends StandardSchemaV1 ? InferInput<Body> : undefined;
  readonly response: {
    [Status in keyof Responses & number]: {
      readonly status: Status;
      readonly body: Responses[Status] extends StandardSchemaV1 ? InferOutput<Responses[Status]> : never;
    }
  }[keyof Responses & number];
}

/** A registered HTTP route. Export it from a handler module. */
export interface HttpRoute<
  ApiId extends string,
  HandlerId extends string,
  Method extends HttpMethod,
  Path extends string,
  Params,
  Query,
  Body,
  Responses extends ResponseSchemas
> extends Described<HandlerDescriptor> {
  readonly "kind": "http.route";
  readonly "id": HandlerId;
  readonly "apiId": ApiId;
  /** Phantom type carrier for client contracts; never present at runtime. */
  readonly "~contract"?: RouteContract<Method, Path, Params, Query, Body, Responses>;
}

/** Extracts the client-facing contract of a route registration. */
export type InferRouteContract<Route> = Route extends { readonly "~contract"?: infer Contract } ? NonNullable<Contract> : never;

/** Options accepted by {@link http.api}. */
export interface HttpApiOptions<Id extends string> {
  readonly id: Id;
  /** Path prefix for every route, for example `/api`. */
  readonly basePath: string;
  readonly docs?: { readonly title: string; readonly version: string };
}

/** A typed handle to a declared HTTP API. */
export interface HttpApiHandle<Id extends string> extends Described<ResourceDescriptor> {
  readonly kind: "http.api";
  readonly id: Id;
  /**
   * Registers a route. Path parameters, query, body and response types are
   * inferred from the declaration.
   *
   * @param options - Route identifier, method, path, schemas and handler.
   * @returns The route registration.
   */
  route: <
    const HandlerId extends string,
    const Method extends HttpMethod,
    const Path extends string,
    Responses extends ResponseSchemas,
    Params extends StandardSchemaV1 | undefined = undefined,
    Query extends StandardSchemaV1 | undefined = undefined,
    Body extends StandardSchemaV1 | undefined = undefined
  >(options: RouteOptions<HandlerId, Method, Path, Params, Query, Body, Responses>
  ) => HttpRoute<Id, HandlerId, Method, Path, Params, Query, Body, Responses>;
}

/**
 * Reads a record of string values from untrusted input.
 *
 * @param value - The untrusted value.
 * @param subject - What is being read, for the error message.
 * @returns The value as a string record, or an empty record when it is `undefined`.
 * @throws {HolqaError} `HOLQA_INPUT_INVALID` when the value is not a record of strings.
 */
function stringRecord(value: unknown, subject: string): Readonly<Record<string, string>> {
  if (value === undefined)
    return {};
  if (typeof value !== "object" || value === null || Object.values(value).some(entry => typeof entry !== "string"))
    fail(experimentCodes.inputInvalid, `Invalid ${subject}: expected a record of strings.`);
  return value as Readonly<Record<string, string>>;
}

/**
 * Declares an HTTP API that routes are registered against.
 *
 * @param options - Identifier, base path and documentation metadata.
 * @returns A typed API handle.
 */
function api<const Id extends string>(options: HttpApiOptions<Id>): HttpApiHandle<Id> {
  const config: JsonObject = definedEntries({
    basePath: options.basePath,
    docs: options.docs === undefined ? undefined : { title: options.docs.title, version: options.docs.version }
  });
  const handle: HttpApiHandle<Id> = {
    [descriptorKey]: resourceDescriptor("http.api", options.id, config, {}),
    kind: "http.api",
    id: options.id,
    route: (route) => {
      const schemas: Record<string, unknown> = { params: route.params, query: route.query, body: route.body };
      for (const [status, schema] of Object.entries(route.responses))
        schemas[`response.${status}`] = schema;

      /**
       * Validates the raw request parts, runs the handler and validates its response.
       *
       * @param input - Untrusted `{ params, query, body, headers }` from the runtime.
       * @param context - The invocation context.
       * @returns The status, validated response body and headers.
       */
      const invoke: HandlerDescriptor["invoke"] = async (input, context) => {
        const request = (typeof input === "object" && input !== null ? input : {}) as { readonly params?: unknown; readonly query?: unknown; readonly body?: unknown; readonly headers?: unknown };
        const subject = `${route.method} ${route.path}`;
        const rawParams = stringRecord(request.params, `path parameters of ${subject}`);
        const rawQuery = stringRecord(request.query, `query of ${subject}`);
        const result = await route.handler({
          params: (route.params === undefined ? rawParams : await validateInput(route.params, rawParams, `path parameters of ${subject}`)) as never,
          query: (route.query === undefined ? rawQuery : await validateInput(route.query, rawQuery, `query of ${subject}`)) as never,
          body: (route.body === undefined ? undefined : await validateInput(route.body, request.body, `body of ${subject}`)) as never,
          headers: stringRecord(request.headers, `headers of ${subject}`),
          signal: context.signal,
          log: context.log,
          reply: ((status: number, body: unknown, headers?: Readonly<Record<string, string>>) => ({ status, body, ...(headers === undefined ? {} : { headers }) })) as never
        });
        const schema: StandardSchemaV1 | undefined = (route.responses as Record<number, StandardSchemaV1>)[result.status];
        if (schema === undefined)
          fail(experimentCodes.declarationInvalid, `Route "${route.id}" returned undeclared status ${String(result.status)}.`);
        return { status: result.status, body: await validateInput(schema, result.body, `${String(result.status)} response of ${subject}`), headers: result.headers ?? {} };
      };

      return Object.freeze({
        [descriptorKey]: handlerDescriptor(route.id, { kind: "http.route", resource: options.id, method: route.method, path: route.path }, {}, schemas, invoke),
        kind: "http.route" as const,
        id: route.id,
        apiId: options.id
      });
    }
  };
  return Object.freeze(handle);
}

/** HTTP resource factories. */
export const http = Object.freeze({ api });