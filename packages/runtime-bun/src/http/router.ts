import type {
  AppDescriptor,
  Diagnostic,
  HandlerDefinition
} from "@holqa/core";

import {
  createDiagnostic,
  diagnosticCodes,
  httpEndpoint,
  httpRouteKeys,
  rpcMountSegment
} from "@holqa/core";

/** How a route's responses and errors are encoded: plain HTTP, or the `holqa.rpc/1` envelope. */
export type RouteTransport = "http" | "rpc";

/** One segment of a route template. */
type Segment = { readonly kind: "static"; readonly value: string } | { readonly kind: "param"; readonly name: string };

/** A route or procedure in the table, with its full path split into segments. */
export interface RouteEntry {
  readonly handlerId: string;
  readonly transport: RouteTransport;
  /** The methods it serves, for example `["GET", "POST"]` for a query procedure. */
  readonly methods: readonly string[];
  /** The full path template, for example `/api/orders/:orderId`. */
  readonly path: string;
  readonly segments: readonly Segment[];
}

/** Every route and procedure an application serves. */
export interface RouteTable {
  /** Ordered so that the first match is the most specific: static segments win over parameters, left to right. */
  readonly entries: readonly RouteEntry[];
  /** The `<basePath>/rpc` prefixes, so unmatched requests under them get RPC envelopes. */
  readonly rpcMounts: ReadonlyArray<readonly string[]>;
}

/** The outcome of matching a request against a route table. */
export type RouteMatch
  = | { readonly kind: "matched"; readonly entry: RouteEntry; readonly params: Readonly<Record<string, string>> }
    | { readonly kind: "method-not-allowed"; readonly allowed: readonly string[]; readonly transport: RouteTransport }
    | { readonly kind: "not-found"; readonly transport: RouteTransport }
    | { readonly kind: "malformed"; readonly transport: RouteTransport };

/**
 * Splits a path into non-empty segments.
 *
 * @param path - A path such as `/api/orders/1`.
 * @returns The segments, for example `["api", "orders", "1"]`.
 */
function splitPath(path: string): string[] {
  return path.split("/").filter(segment => segment.length > 0);
}

/**
 * Parses a path template into segments.
 *
 * @param path - A template such as `/api/orders/:orderId`.
 * @returns Its segments.
 */
function templateSegments(path: string): Segment[] {
  return splitPath(path).map(segment => segment.startsWith(":") ? { kind: "param", name: segment.slice(1) } : { kind: "static", value: segment });
}

/**
 * Orders two templates of the same length: the first position where they
 * differ decides, and a static segment comes before a parameter.
 *
 * @param left - A route entry.
 * @param right - Another route entry.
 * @returns A negative number when `left` is more specific.
 */
function compareSpecificity(left: RouteEntry, right: RouteEntry): number {
  for (let index = 0; index < Math.min(left.segments.length, right.segments.length); index += 1) {
    const a = left.segments[index]!.kind;
    const b = right.segments[index]!.kind;
    if (a !== b)
      return a === "static" ? -1 : 1;
  }
  return left.segments.length - right.segments.length || (left.handlerId < right.handlerId ? -1 : left.handlerId > right.handlerId ? 1 : 0);
}

/**
 * Builds the route table of an application from its HTTP handlers: routes
 * under their API's base path, and procedures at `<basePath>/rpc/<id>`.
 * Two handlers that serve the same method and path shape (parameter names
 * ignored) conflict, also across APIs, because one server serves them all.
 *
 * @param app - The application, for API base paths.
 * @param handlers - Every registered handler's definition.
 * @returns The table, and one `HOLQA_ROUTE_CONFLICT` diagnostic per conflict.
 */
export function buildRouteTable(app: AppDescriptor, handlers: Iterable<HandlerDefinition>): { readonly table: RouteTable; readonly problems: readonly Diagnostic[] } {
  const basePaths = new Map(app.resources.filter(resource => resource.kind === "http.api").map(resource => [resource.id, (resource.config as { readonly basePath: string }).basePath]));
  const entries: RouteEntry[] = [];
  const byKey = new Map<string, string[]>();
  for (const definition of handlers) {
    const basePath = basePaths.get(definition.trigger.resource.id);
    const endpoint = basePath === undefined ? undefined : httpEndpoint(basePath, definition);
    if (basePath === undefined || endpoint === undefined)
      continue;
    entries.push({ handlerId: definition.id, transport: definition.trigger.kind === "http.route" ? "http" : "rpc", methods: endpoint.methods, path: endpoint.path, segments: templateSegments(endpoint.path) });
    // The same rule the compiler applies (`httpRouteKeys`), so a compiled application never conflicts here.
    for (const key of httpRouteKeys(basePath, definition))
      byKey.set(key, [...byKey.get(key) ?? [], definition.id]);
  }
  entries.sort(compareSpecificity);
  const problems = [...byKey].filter(([, ids]) => ids.length > 1).map(([route, ids]) => createDiagnostic({
    code: diagnosticCodes.routeConflict,
    severity: "error",
    message: `The handlers ${ids.map(id => `"${id}"`).join(", ")} all serve ${route}.`,
    hint: "Give one of them a different method or path, or a different API base path.",
    details: { route, handlers: [...ids].sort() }
  }));
  const rpcMounts = [...new Set(basePaths.values())].map(basePath => [...splitPath(basePath), rpcMountSegment]);
  return { table: Object.freeze({ entries: Object.freeze(entries), rpcMounts: Object.freeze(rpcMounts) }), problems };
}

/**
 * Matches a request against a route table. `HEAD` matches `GET` routes.
 * Path segments are percent-decoded before comparison; a trailing `/` is
 * ignored.
 *
 * @param table - The routes and procedures to match against.
 * @param method - The request method.
 * @param pathname - The request path, still percent-encoded.
 * @returns The most specific route serving the method with its parameters, a method mismatch with the allowed methods, not found, or malformed.
 */
export function matchRoute(table: RouteTable, method: string, pathname: string): RouteMatch {
  const raw = splitPath(pathname);
  const transport: RouteTransport = table.rpcMounts.some(mount => mount.every((segment, index) => raw[index] === segment)) ? "rpc" : "http";
  let segments: string[];
  try {
    segments = raw.map(segment => decodeURIComponent(segment));
  } catch {
    return { kind: "malformed", transport };
  }
  const wanted = method === "HEAD" ? "GET" : method;
  const allowed = new Set<string>();
  for (const entry of table.entries) {
    const params = matchSegments(entry.segments, segments);
    if (params === undefined)
      continue;
    if (entry.methods.includes(wanted))
      return { kind: "matched", entry, params };
    for (const candidate of entry.methods)
      allowed.add(candidate);
  }
  if (allowed.size === 0)
    return { kind: "not-found", transport };
  if (allowed.has("GET"))
    allowed.add("HEAD");
  return { kind: "method-not-allowed", allowed: [...allowed].sort(), transport };
}

/**
 * Matches decoded path segments against a template.
 *
 * @param template - Route segments.
 * @param segments - Decoded request segments.
 * @returns The captured parameters, or `undefined` when the path does not match.
 */
function matchSegments(template: readonly Segment[], segments: readonly string[]): Readonly<Record<string, string>> | undefined {
  if (template.length !== segments.length)
    return undefined;
  const params: Array<[string, string]> = [];
  for (const [index, part] of template.entries()) {
    const segment = segments[index]!;
    if (part.kind === "param")
      params.push([part.name, segment]);
    else if (part.value !== segment)
      return undefined;
  }
  // `Object.fromEntries` defines own properties, so a parameter named `__proto__` cannot change the prototype.
  return Object.freeze(Object.fromEntries(params));
}