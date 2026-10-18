import type {
  HttpApiDocs,
  HttpMethod,
  HttpProcedureOperation,
  ResourceDescriptorOf,
  StandardSchemaV1
} from "@holqa/core";

import type {
  AnyHttpMiddleware,
  CheckMiddlewareChain,
  MiddlewareChainContext
} from "@/http/middleware";
import type {
  HttpProcedure,
  ProcedureContract,
  ProcedureOptions
} from "@/http/procedure";
import type {
  HttpRoute,
  ResponseSchemas,
  RouteContract,
  RouteOptions
} from "@/http/route";
import type { ResourceHandle } from "@/resources/handle";
import type { CheckResourceId } from "@/types/checks";

import {
  descriptorKey,
  descriptorProtocol
} from "@holqa/core";

import { middlewareList } from "@/http/middleware";
import { createProcedure } from "@/http/procedure";
import { createRoute } from "@/http/route";
import { appMiddlewareOf } from "@/internal/app-middleware";
import {
  DeclarationProblems,
  definedEntries,
  freezeJson,
  optionalObject,
  requireOptions
} from "@/internal/declaration";
import { ownerOf } from "@/internal/ownership";

/** `/`, or a path of non-empty segments that starts with `/` and does not end with one. */
const basePathPattern = /^\/$|^(?:\/[\w.~-]+)+$/;

/**
 * Options accepted by {@link http.api}.
 *
 * @typeParam Id - The literal identifier.
 * @typeParam Middleware - The API's middleware, in execution order.
 */
export interface HttpApiOptions<Id extends string, Middleware extends readonly AnyHttpMiddleware[] = []> {
  /** The persistent identity of the API. */
  readonly id: Id;
  /** Path prefix for every route, for example `/api`. */
  readonly basePath: string;
  /** Documentation metadata, for example for generated API descriptions. */
  readonly docs?: HttpApiDocs;
  /** Middleware for every route and procedure of the API; it runs after application middleware. */
  readonly middleware?: Middleware & CheckMiddlewareChain<{}, Middleware>;
}

/**
 * A typed handle to a declared HTTP API, on which routes and RPC procedures
 * are registered.
 *
 * @typeParam Id - The literal identifier.
 * @typeParam Context - The typed context the API's (and, through `defineApp`, the application's) middleware provides.
 */
export interface HttpApiHandle<Id extends string, Context extends object = {}> extends ResourceHandle<"http.api", Id> {
  /** Phantom type carrier for the middleware context; never present at run time. */
  readonly "~context"?: Context;
  /**
   * Registers a route. Path parameter, query, header, body and response types
   * are inferred from the declaration. Registration is declarative: nothing
   * runs until a runtime routes a request to it.
   */
  readonly "route": <
    const HandlerId extends string,
    const Method extends HttpMethod,
    const Path extends string,
    Responses extends ResponseSchemas,
    Params extends StandardSchemaV1 | undefined = undefined,
    Query extends StandardSchemaV1 | undefined = undefined,
    Body extends StandardSchemaV1 | undefined = undefined,
    Headers extends StandardSchemaV1 | undefined = undefined,
    const Middleware extends readonly AnyHttpMiddleware[] = []
  >(options: RouteOptions<HandlerId, Method, Path, Params, Query, Body, Headers, Responses, Middleware, Context> & CheckResourceId<HandlerId>
  ) => HttpRoute<Id, HandlerId, RouteContract<Method, Path, Params, Query, Body, Headers, Responses>>;
  /**
   * Registers an RPC procedure, served at `<basePath>/rpc/<id>` with the
   * `holqa.rpc/1` protocol. Registration is declarative.
   */
  readonly "procedure": <
    const HandlerId extends string,
    const Operation extends HttpProcedureOperation,
    Output extends StandardSchemaV1,
    Input extends StandardSchemaV1 | undefined = undefined,
    const Middleware extends readonly AnyHttpMiddleware[] = []
  >(options: ProcedureOptions<HandlerId, Operation, Input, Output, Middleware, Context> & CheckResourceId<HandlerId>
  ) => HttpProcedure<Id, HandlerId, ProcedureContract<Operation, Input, Output>>;
}

/**
 * Declares an HTTP API that routes and procedures are registered against.
 * Pure: opens no port and creates no infrastructure.
 *
 * @param options - Identifier, base path, documentation metadata and middleware.
 * @returns A typed API handle.
 * @throws {HolqaError} `HOLQA_RESOURCE_ID_INVALID` for an invalid identifier, or `HOLQA_DECLARATION_INVALID` for a malformed option.
 */
function api<const Id extends string, const Middleware extends readonly AnyHttpMiddleware[] = []>(options: HttpApiOptions<Id, Middleware> & CheckResourceId<Id>): HttpApiHandle<Id, MiddlewareChainContext<{}, Middleware>> {
  const raw = requireOptions(options, "http.api");
  const problems = new DeclarationProblems(`http.api "${String(raw.id)}"`);
  const idCandidate = problems.identifier(raw.id, "api id");
  if (typeof raw.basePath !== "string" || !basePathPattern.test(raw.basePath))
    problems.invalid("\"basePath\" must be \"/\" or a path such as \"/api\" that starts with \"/\" and does not end with one.");
  const docs = optionalObject<HttpApiDocs>(raw.docs, "docs", problems);
  if (raw.docs !== undefined && (typeof docs.title !== "string" || docs.title === "" || typeof docs.version !== "string" || docs.version === ""))
    problems.invalid("\"docs\" must have a non-empty \"title\" and \"version\".");
  const apiMiddleware = middlewareList(raw.middleware, problems);
  const id = problems.valid(idCandidate);

  const descriptor: ResourceDescriptorOf<"http.api"> = Object.freeze({
    protocol: descriptorProtocol,
    type: "resource",
    kind: "http.api",
    id,
    config: freezeJson({
      basePath: options.basePath,
      ...definedEntries({ docs: options.docs === undefined ? undefined : { title: options.docs.title, version: options.docs.version } })
    }),
    requirements: freezeJson({}),
    schemas: Object.freeze({})
  });

  // The handle is created below; `self` lets the middleware lookup find its owner lazily.
  let self: object = descriptor;
  const host = {
    apiId: id,
    // Read when an invocation runs, not when a route is registered: handler
    // modules may register routes before `defineApp` has claimed the API.
    // An API that was never passed to `defineApp` (or was claimed by another
    // copy of the SDK) fails here instead of silently skipping application
    // middleware such as authentication.
    middleware: () => [...appMiddlewareOf(ownerOf(self, `A route or procedure of http.api "${id}"`)), ...apiMiddleware]
  };
  // The generic signatures of `route` and `procedure` are enforced by the
  // public type; at run time both delegate to builders that validate their
  // untrusted options, so the handle is cast once here.
  const handle: HttpApiHandle<Id, MiddlewareChainContext<{}, Middleware>> = Object.freeze({
    [descriptorKey]: descriptor,
    kind: "http.api" as const,
    id: options.id,
    route: (route: Parameters<typeof createRoute>[1]) => createRoute(host, route),
    procedure: (procedure: Parameters<typeof createProcedure>[1]) => createProcedure(host, procedure)
  }) as never;
  self = handle;
  return handle;
}

/** HTTP resource factories. */
export const http = Object.freeze({ api });