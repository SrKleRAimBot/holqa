import type { HandlerDefinition } from "@/handlers/handler-descriptor";
import type { HttpMethod } from "@/handlers/triggers";

import { rpcProcedurePath } from "@/rpc/rpc-protocol";

/**
 * Joins an API base path and a route path into one normalized path with a
 * single leading slash, no trailing slash and no empty segments.
 *
 * @param basePath - The API's base path, for example `/api`.
 * @param path - The route path relative to the base path, for example `/orders/:orderId`.
 * @returns The joined path, for example `/api/orders/:orderId`.
 */
export function joinRoutePath(basePath: string, path: string): string {
  const segments = [...basePath.split("/"), ...path.split("/")].filter(segment => segment.length > 0);
  return `/${segments.join("/")}`;
}

/**
 * Reduces a route path to the shape a router matches on: every `:name`
 * parameter segment becomes `:`. Two routes with the same method and shape
 * match exactly the same requests, whatever their parameter names.
 *
 * A static segment and a parameter at the same position (`/orders/new` and
 * `/orders/:id`) have different shapes and do not conflict: routers are
 * required to prefer the static segment.
 *
 * @param path - A normalized route path.
 * @returns The path shape, for example `/api/orders/:`.
 */
export function routeShape(path: string): string {
  return path.split("/").map(segment => segment.startsWith(":") ? ":" : segment).join("/");
}

/** The full path and methods an HTTP handler serves. */
export interface HttpEndpoint {
  /** The full path template, for example `/api/orders/:orderId` or `/api/rpc/orders.get`. */
  readonly path: string;
  /** The methods served: the route's method, `POST` for a mutation, `GET` and `POST` for a query. */
  readonly methods: readonly HttpMethod[];
}

/**
 * Returns where an `http.route` or `http.procedure` handler is served:
 * routes under their API's base path, procedures at `<basePath>/rpc/<id>`.
 *
 * @param basePath - The base path of the handler's API.
 * @param definition - The handler's definition.
 * @returns The endpoint, or `undefined` for handlers of other trigger kinds.
 */
export function httpEndpoint(basePath: string, definition: HandlerDefinition): HttpEndpoint | undefined {
  const { trigger } = definition;
  if (trigger.kind === "http.route")
    return { path: joinRoutePath(basePath, trigger.options.path), methods: [trigger.options.method] };
  if (trigger.kind === "http.procedure")
    return { path: rpcProcedurePath(basePath, definition.id), methods: trigger.options.operation === "query" ? ["GET", "POST"] : ["POST"] };
  return undefined;
}

/**
 * Returns the keys that identify the requests an HTTP handler serves, one
 * per method: `<METHOD> <shape>`, for example `GET /api/orders/:`. Two
 * handlers of one application that share a key conflict, whichever APIs they
 * belong to, because one server serves every API. The compiler and runtimes
 * use this one rule.
 *
 * @param basePath - The base path of the handler's API.
 * @param definition - The handler's definition.
 * @returns The keys; empty for handlers of other trigger kinds.
 */
export function httpRouteKeys(basePath: string, definition: HandlerDefinition): readonly string[] {
  const endpoint = httpEndpoint(basePath, definition);
  return endpoint === undefined ? [] : endpoint.methods.map(method => `${method} ${routeShape(endpoint.path)}`);
}