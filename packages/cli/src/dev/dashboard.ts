import type {
  JsonObject,
  JsonValue
} from "@holqa/core";

import { dashboardPage } from "@/dev/dashboard-page";

/** Where the dashboard is served. */
export const dashboardPath = "/_holqa/dashboard";

/** Host names a loopback dashboard answers to; other `Host` headers are refused, which defeats DNS rebinding. */
const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/**
 * What the dashboard presents. Every source is an interface the session
 * already has for its own output and for the CLI: the supervisor's status,
 * the `state` operation, the session's log events and the local telemetry
 * store that `holqa traces` reads. The dashboard stores nothing.
 */
export interface DashboardSource {
  /** The supervisor's status: serving generation, handler versions, stale state, reloads. */
  readonly status: () => JsonObject;
  /** The local state of queues, buckets and schedules, as `holqa state --json` reports it; `undefined` without a running generation. */
  readonly state: () => Promise<JsonObject | undefined>;
  /** The session's most recent log entries, oldest first. */
  readonly logs: () => readonly JsonObject[];
  /** The most recent traces, as `holqa traces list --json` reports them. */
  readonly traces: () => JsonValue;
  /** One trace's spans, as `holqa traces inspect --json` reports them; `undefined` when unknown. */
  readonly trace: (traceId: string) => JsonValue | undefined;
}

/**
 * Reports whether a host name is a loopback address.
 *
 * @param hostname - A host name or address, without a port.
 * @returns `true` for `127.0.0.1`, `localhost` and `::1`.
 */
export function isLoopbackHost(hostname: string): boolean {
  return loopbackHosts.has(hostname.toLowerCase());
}

/**
 * Builds a JSON response that browsers neither cache nor sniff.
 *
 * @param body - The JSON data to send.
 * @param status - The HTTP status code, 200 by default.
 * @returns The response.
 */
function json(body: JsonValue, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } });
}

/**
 * Removes message payloads from a `state` result. The dashboard is readable by
 * anyone who can reach the loopback address, so it shows identifiers, states,
 * attempts and errors, never message contents; `holqa state` shows them.
 *
 * @param state - The `state` operation's result.
 * @returns The result without `payload` fields.
 */
export function withoutPayloads(state: JsonObject): JsonObject {
  const { queues } = state as { readonly queues?: JsonValue };
  return {
    ...state,
    queues: (Array.isArray(queues) ? queues : []).map((queue) => {
      if (typeof queue !== "object" || queue === null || Array.isArray(queue))
        return queue;
      const { messages } = queue as { readonly messages?: JsonValue };
      return {
        ...queue,
        messages: (Array.isArray(messages) ? messages : []).map((message: JsonValue) => {
          if (typeof message !== "object" || message === null || Array.isArray(message))
            return message;
          const { payload: _payload, ...rest } = message as JsonObject;
          return rest;
        })
      };
    })
  };
}

/**
 * Serves the development dashboard and its read-only JSON API:
 *
 * - `GET /_holqa/dashboard`: the page.
 * - `GET /_holqa/dashboard/api/status`: generation, handler versions, stale state, reloads.
 * - `GET /_holqa/dashboard/api/state`: queues, buckets and schedules, without message payloads.
 * - `GET /_holqa/dashboard/api/logs`: recent log entries.
 * - `GET /_holqa/dashboard/api/traces` and `/api/traces/<trace-id>`: traces from the local telemetry store.
 *
 * Only requests whose `Host` header names a loopback address are answered.
 *
 * @param request - The incoming request, whose path starts with {@link dashboardPath}.
 * @param source - What the dashboard presents.
 * @returns The response.
 */
export async function serveDashboard(request: Request, source: DashboardSource): Promise<Response> {
  const url = new URL(request.url);
  const host = request.headers.get("host") ?? url.host;
  const hostname = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.split(":")[0]!;
  if (!isLoopbackHost(hostname))
    return new Response("The holqa dev dashboard only answers loopback addresses.", { status: 403 });
  if (request.method !== "GET" && request.method !== "HEAD")
    return new Response(null, { status: 405, headers: { allow: "GET, HEAD" } });
  const path = url.pathname.slice(dashboardPath.length);
  if (path === "" || path === "/") {
    const nonce = crypto.randomUUID().replace(/-/g, "");
    return new Response(dashboardPage(nonce), {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
        "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`
      }
    });
  }
  switch (path) {
    case "/api/status":
      return json(source.status());
    case "/api/state": {
      const state = await source.state();
      return state === undefined ? json({ error: "No generation is running." }, 503) : json(withoutPayloads(state));
    }
    case "/api/logs":
      return json({ entries: [...source.logs()] });
    case "/api/traces":
      return json({ traces: source.traces() });
  }
  if (path.startsWith("/api/traces/")) {
    const spans = source.trace(decodeURIComponent(path.slice("/api/traces/".length)));
    return spans === undefined ? json({ error: "No such trace." }, 404) : json({ spans });
  }
  return json({ error: "Not found." }, 404);
}