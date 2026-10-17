import type {
  HandlerInfo,
  ResourceInfo
} from "@/generation/registry";

/** A route of the current generation, with its full path split into segments. */
export interface RouteEntry {
  readonly handlerId: string;
  readonly method: string;
  readonly segments: readonly string[];
  readonly staticSegments: number;
}

/** The outcome of matching a request path against routes. */
export type RouteMatch
  = | { readonly kind: "matched"; readonly route: RouteEntry; readonly params: Readonly<Record<string, string>> }
    | { readonly kind: "method-not-allowed"; readonly allowed: readonly string[] }
    | { readonly kind: "not-found" };

/**
 * Splits a URL path into non-empty segments.
 *
 * @param path - A path such as `/api/orders/1`.
 * @returns The segments, for example `["api", "orders", "1"]`.
 */
function splitPath(path: string): string[] {
  return path.split("/").filter(segment => segment.length > 0);
}

/**
 * Builds the route table of a generation: every `http.route` handler with its
 * API's base path prepended. More specific routes (more static segments) come
 * first, then routes are ordered by handler identifier, so matching is deterministic.
 *
 * @param handlers - The generation's handlers.
 * @param resources - The generation's resources, for API base paths.
 * @returns The ordered route table.
 */
export function routeTable(handlers: ReadonlyMap<string, HandlerInfo>, resources: ReadonlyMap<string, ResourceInfo>): RouteEntry[] {
  const routes: RouteEntry[] = [];
  for (const handler of handlers.values()) {
    const { kind, resource, method, path } = handler.trigger;
    if (kind !== "http.route" || typeof method !== "string" || typeof path !== "string")
      continue;
    const { basePath } = resources.get(resource)?.config ?? {};
    const segments = [...splitPath(typeof basePath === "string" ? basePath : ""), ...splitPath(path)];
    routes.push({ handlerId: handler.id, method, segments, staticSegments: segments.filter(segment => !segment.startsWith(":")).length });
  }
  return routes.sort((left, right) => right.staticSegments - left.staticSegments || left.handlerId.localeCompare(right.handlerId));
}

/**
 * Matches a request against a route table.
 *
 * @param routes - The ordered route table.
 * @param method - The request method.
 * @param pathname - The request path.
 * @returns The matched route with decoded path parameters, a method mismatch, or not found.
 */
export function matchRoute(routes: readonly RouteEntry[], method: string, pathname: string): RouteMatch {
  const segments = splitPath(pathname);
  const allowed: string[] = [];
  for (const route of routes) {
    const params = matchSegments(route.segments, segments);
    if (params === undefined)
      continue;
    if (route.method === method)
      return { kind: "matched", route, params };
    allowed.push(route.method);
  }
  return allowed.length > 0 ? { kind: "method-not-allowed", allowed } : { kind: "not-found" };
}

/**
 * Matches path segments against a route template.
 *
 * @param template - Route segments; `:name` segments capture a parameter.
 * @param segments - Request segments.
 * @returns The captured parameters, or `undefined` when the path does not match.
 */
function matchSegments(template: readonly string[], segments: readonly string[]): Record<string, string> | undefined {
  if (template.length !== segments.length)
    return undefined;
  const params: Record<string, string> = {};
  for (const [index, part] of template.entries()) {
    const segment = segments[index] ?? "";
    if (part.startsWith(":"))
      params[part.slice(1)] = decodeURIComponent(segment);
    else if (part !== segment)
      return undefined;
  }
  return params;
}