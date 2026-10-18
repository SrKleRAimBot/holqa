import { HttpRejectedError } from "@holqa/core";
import { middleware } from "@holqa/sdk";

/** A signed-in user, added to the context by {@link authenticate}. */
export interface User {
  readonly id: string;
  readonly name: string;
}

/** Demo bearer tokens. A real application verifies tokens with its identity provider. */
const users: ReadonlyMap<string, User> = new Map([["Bearer token-ada", { id: "u1", name: "Ada" }]]);

/** Adds the request's correlation identifier to the context and reports the handling time. */
export const requestContext = middleware({
  name: "request-context",
  handle: async ({ correlationId, next }) => {
    const started = performance.now();
    const result = await next({ requestId: correlationId });
    const headers = new Headers(result.response.headers);
    headers.set("server-timing", `app;dur=${(performance.now() - started).toFixed(1)}`);
    return { ...result, response: new Response(result.response.body, { status: result.response.status, headers }) };
  }
});

/** Rejects requests without a known bearer token and adds the user to the context. */
export const authenticate = middleware({
  name: "authenticate",
  handle: async ({ request, next }) => {
    const user = users.get(request.headers.get("authorization") ?? "");
    if (user === undefined)
      throw new HttpRejectedError(401, "Sign in to continue.", { headers: { "www-authenticate": "Bearer" } });
    return next({ user });
  }
});