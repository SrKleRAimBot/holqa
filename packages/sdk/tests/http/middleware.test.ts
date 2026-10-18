import type {
  CheckMiddlewareChain,
  ExtendContext,
  HolqaTypeError,
  HttpApiHandle,
  HttpMiddleware,
  MiddlewareChainContext
} from "@/index";

import { HttpRejectedError } from "@holqa/core";
import {
  invokeHttp,
  owned,
  rejectedCodes
} from "@test/support/http";
import { thrownCodes } from "@test/support/test-binding";
import {
  describe,
  expect,
  expectTypeOf,
  it
} from "bun:test";
import { z } from "zod";

import {
  defineApp,
  http,
  middleware
} from "@/index";

/** A user added to the context by {@link authenticate}. */
interface User {
  readonly id: string;
  readonly roles: readonly string[];
}

/** Rejects requests without a bearer token and adds the user to the context. */
const authenticate = middleware({
  name: "authenticate",
  handle: async ({ request, next }) => {
    const token = request.headers.get("authorization");
    if (token !== "Bearer good")
      throw new HttpRejectedError(401, "Sign in to continue.", { headers: { "www-authenticate": "Bearer" } });
    const user: User = { id: "u1", roles: ["admin"] };
    return next({ user });
  }
});

/** Requires a user and adds whether it is an administrator. */
const authorize = middleware.requires<{ readonly user: User }>()({
  name: "authorize",
  handle: ({ context, next }) => next({ isAdmin: context.user.roles.includes("admin") })
});

/**
 * Builds middleware that records when it runs before and after the rest of the chain.
 *
 * @param name - The middleware's name.
 * @param events - Where events are recorded.
 * @returns The middleware.
 */
function recorder(name: string, events: string[]): HttpMiddleware<{}, {}> {
  return middleware({
    name,
    handle: async ({ next }) => {
      events.push(`${name}:before`);
      try {
        return await next();
      } finally {
        events.push(`${name}:after`);
      }
    }
  });
}

describe("middleware types", () => {
  it("infers the context a middleware adds from what it passes to next", () => {
    expectTypeOf<MiddlewareChainContext<{}, [typeof authenticate]>>().toEqualTypeOf<{ readonly user: User }>();
    expectTypeOf<MiddlewareChainContext<{}, [typeof authenticate, typeof authorize]>>().toEqualTypeOf<{ readonly user: User; readonly isAdmin: boolean }>();
  });

  it("rejects a chain in which a middleware runs before the context it requires exists", () => {
    expectTypeOf<CheckMiddlewareChain<{}, [typeof authenticate, typeof authorize]>>().toEqualTypeOf<unknown>();
    expectTypeOf<CheckMiddlewareChain<{}, [typeof authorize]>>().not.toEqualTypeOf<unknown>();
    /** Holds deliberate type errors checked by tsc; never executed. */
    const neverCalled = (): void => {
      // @ts-expect-error -- authorize needs the user that authenticate adds, so it must come later.
      http.api({ id: "wrong-order", basePath: "/", middleware: [authorize, authenticate] });
      const plain = http.api({ id: "plain", basePath: "/" });
      plain.route({
        id: "a",
        method: "GET",
        path: "/",
        responses: { 200: z.string() },
        // @ts-expect-error -- nothing provides the user on this route.
        middleware: [authorize],
        handler: ({ reply }) => reply(200, "ok")
      });
    };
    expect(typeof neverCalled).toBe("function");
  });

  it("never invents context that next() did not receive", () => {
    /** Holds deliberate type errors checked by tsc; never executed. */
    const neverCalled = (): void => {
      // @ts-expect-error -- next() without an argument adds nothing, so it cannot satisfy a declared extension.
      middleware<{ user: User }>({ name: "a", handle: ({ next }) => next() });
      // @ts-expect-error -- an explicit extension type needs the matching value.
      middleware({ name: "b", handle: ({ next }) => next<{ user: User }>() });
    };
    expect(typeof neverCalled).toBe("function");
  });

  it("rejects middleware that requires context in a list whose order is unknown", () => {
    const list = [authorize];
    expectTypeOf<CheckMiddlewareChain<{}, typeof list>>().not.toEqualTypeOf<unknown>();
    const _plainList = [authenticate];
    expectTypeOf<CheckMiddlewareChain<{}, typeof _plainList>>().toEqualTypeOf<unknown>();
    /** Holds deliberate type errors checked by tsc; never executed. */
    const neverCalled = (): void => {
      // @ts-expect-error -- the array type loses the order, so authorize's requirement cannot be checked.
      http.api({ id: "array-api", basePath: "/", middleware: list });
      // @ts-expect-error -- application middleware is checked the same way.
      defineApp({ name: "wrong-app", resources: {}, middleware: [authorize, authenticate] });
    };
    expect(typeof neverCalled).toBe("function");
  });

  it("keeps optional context properties optional and lets later ones replace earlier ones", () => {
    expectTypeOf<ExtendContext<{ readonly a: 1 }, { user?: User }>>().toEqualTypeOf<{ readonly a: 1; readonly user?: User }>();
    expectTypeOf<ExtendContext<{ readonly a: 1 }, { a?: string }>>().toEqualTypeOf<{ readonly a?: string }>();
    expectTypeOf<ExtendContext<{ readonly a: 1 }, {}>>().toEqualTypeOf<{ readonly a: 1 }>();
  });

  it("names required context that exists with an incompatible type", () => {
    expectTypeOf<CheckMiddlewareChain<{ readonly user: string }, [typeof authorize]>>().toEqualTypeOf<HolqaTypeError<"A middleware requires context that earlier middleware does not provide: user.">>();
  });

  it("types the context of routes from API and route middleware", () => {
    const api = http.api({ id: "secure-api", basePath: "/api", middleware: [authenticate] });
    expectTypeOf(api).toEqualTypeOf<HttpApiHandle<"secure-api", { readonly user: User }>>();
    api.route({
      id: "me",
      method: "GET",
      path: "/me",
      middleware: [authorize],
      responses: { 200: z.object({ id: z.string() }) },
      handler: ({ context, reply }) => {
        expectTypeOf(context).toEqualTypeOf<Readonly<{ readonly user: User; readonly isAdmin: boolean }>>();
        return reply(200, { id: context.user.id });
      }
    });
  });

  it("types the context of routes registered through app.resources with application middleware", () => {
    const requestId = middleware({ name: "request-id", handle: ({ correlationId, next }) => next({ requestId: correlationId }) });
    const api = http.api({ id: "typed-api", basePath: "/", middleware: [authenticate] });
    const other = http.api({ id: "other-api", basePath: "/other" });
    const app = defineApp({ name: "typed", resources: { api, other }, middleware: [requestId] });
    expectTypeOf(app.resources.api).toEqualTypeOf<HttpApiHandle<"typed-api", { readonly requestId: string; readonly user: User }>>();
    expectTypeOf(app.resources.other).toEqualTypeOf<HttpApiHandle<"other-api", { readonly requestId: string }>>();
    const plain = defineApp({ name: "plain", resources: { api: http.api({ id: "plain-api", basePath: "/" }) } });
    expectTypeOf(plain.resources.api).toEqualTypeOf<HttpApiHandle<"plain-api">>();
  });
});

describe("middleware execution", () => {
  it("runs application, API and route middleware in order, around the handler", async () => {
    const events: string[] = [];
    const api = http.api({ id: "ordered-api", basePath: "/", middleware: [recorder("api", events)] });
    const app = defineApp({ name: "ordered", resources: { api }, middleware: [recorder("app", events)] });
    const route = app.resources.api.route({
      id: "ordered",
      method: "GET",
      path: "/",
      middleware: [recorder("route-1", events), recorder("route-2", events)],
      responses: { 200: z.string() },
      handler: ({ reply }) => {
        events.push("handler");
        return reply(200, "ok");
      }
    });
    expect((await invokeHttp(route, new Request("http://localhost/"))).status).toBe(200);
    expect(events).toEqual(["app:before", "api:before", "route-1:before", "route-2:before", "handler", "route-2:after", "route-1:after", "api:after", "app:after"]);
  });

  it("passes the extended context to the handler and replaces earlier values with later ones", async () => {
    const api = owned(http.api({ id: "context-api", basePath: "/", middleware: [authenticate] }));
    const override = middleware({ name: "override", handle: ({ next }) => next({ isAdmin: false }) });
    const route = api.route({
      id: "context",
      method: "GET",
      path: "/",
      middleware: [authorize, override],
      responses: { 200: z.object({ user: z.string(), isAdmin: z.boolean() }) },
      handler: ({ context, reply }) => reply(200, { user: context.user.id, isAdmin: context.isAdmin })
    });
    const response = await invokeHttp(route, new Request("http://localhost/", { headers: { authorization: "Bearer good" } }));
    expect(await response.json()).toEqual({ user: "u1", isAdmin: false });
  });

  it("short-circuits with a returned response or a thrown rejection", async () => {
    let handled = false;
    const maintenance = middleware({ name: "maintenance", handle: () => new Response("down", { status: 503 }) });
    const api = owned(http.api({ id: "short-api", basePath: "/" }));
    const closed = api.route({ id: "closed", method: "GET", path: "/closed", middleware: [maintenance], responses: { 200: z.string() }, handler: ({ reply }) => {
      handled = true;
      return reply(200, "ok");
    } });
    const secured = api.route({ id: "secured", method: "GET", path: "/secured", middleware: [authenticate], responses: { 200: z.string() }, handler: ({ reply }) => {
      handled = true;
      return reply(200, "ok");
    } });
    const response = await invokeHttp(closed, new Request("http://localhost/closed"));
    expect([response.status, await response.text()]).toEqual([503, "down"]);
    expect(await rejectedCodes(() => invokeHttp(secured, new Request("http://localhost/secured")))).toEqual(["HOLQA_HTTP_REJECTED"]);
    expect(handled).toBe(false);
  });

  it("lets middleware change the response after the handler", async () => {
    const tag = middleware({
      name: "tag",
      handle: async ({ next }) => {
        const result = await next();
        const headers = new Headers(result.response.headers);
        headers.set("x-served-by", "holqa");
        return { ...result, response: new Response(result.response.body, { status: result.response.status, headers }) };
      }
    });
    const route = owned(http.api({ id: "tag-api", basePath: "/" })).route({ id: "tagged", method: "GET", path: "/", middleware: [tag], responses: { 200: z.string() }, handler: ({ reply }) => reply(200, "ok") });
    const response = await invokeHttp(route, new Request("http://localhost/"));
    expect(response.headers.get("x-served-by")).toBe("holqa");
    expect(await response.json()).toBe("ok");
  });

  it("propagates handler errors through middleware, which can observe them and clean up", async () => {
    const events: string[] = [];
    const observe = middleware({
      name: "observe",
      handle: async ({ next }) => {
        try {
          return await next();
        } catch (error) {
          events.push(`saw ${(error as Error).message}`);
          throw error;
        } finally {
          events.push("cleanup");
        }
      }
    });
    const route = owned(http.api({ id: "errors-api", basePath: "/" })).route({ id: "fails", method: "GET", path: "/", middleware: [observe], responses: { 200: z.string() }, handler: () => {
      throw new Error("boom");
    } });
    await expect(invokeHttp(route, new Request("http://localhost/"))).rejects.toThrow("boom");
    expect(events).toEqual(["saw boom", "cleanup"]);
  });

  it("can translate errors into responses", async () => {
    const recover = middleware({
      name: "recover",
      handle: async ({ next }) => {
        try {
          return await next();
        } catch {
          return new Response("recovered", { status: 500 });
        }
      }
    });
    const route = owned(http.api({ id: "recover-api", basePath: "/" })).route({ id: "recovers", method: "GET", path: "/", middleware: [recover], responses: { 200: z.string() }, handler: () => {
      throw new Error("boom");
    } });
    expect((await invokeHttp(route, new Request("http://localhost/"))).status).toBe(500);
  });

  it("rejects calling next twice, non-object extensions and invalid return values", async () => {
    const twice = middleware({ name: "twice", handle: async ({ next }) => {
      await next();
      return next();
    } });
    const badExtension = middleware({ name: "bad-extension", handle: ({ next }) => next("user" as never) });
    const badReturn = middleware({ name: "bad-return", handle: () => "ok" as never });
    const api = owned(http.api({ id: "misuse-api", basePath: "/" }));
    /**
     * Registers a route behind one middleware.
     *
     * @param id - The route identifier.
     * @param guard - The middleware.
     * @returns The route.
     */
    const behind = (id: string, guard: HttpMiddleware<{}, object>): ReturnType<typeof api.route> => api.route({ id: id as "x", method: "GET", path: "/", middleware: [guard], responses: { 200: z.string() }, handler: ({ reply }) => reply(200, "ok") }) as never;
    await expect(invokeHttp(behind("twice", twice), new Request("http://localhost/"))).rejects.toThrow("more than once");
    await expect(invokeHttp(behind("bad-extension", badExtension), new Request("http://localhost/"))).rejects.toThrow("not an object");
    expect(await rejectedCodes(() => invokeHttp(behind("bad-return", badReturn), new Request("http://localhost/")))).toEqual(["HOLQA_RESPONSE_INVALID"]);
  });

  it("validates middleware declarations", () => {
    expect(thrownCodes(() => middleware({ name: "", handle: ({ next }) => next() }))).toEqual(["HOLQA_DECLARATION_INVALID"]);
    expect(thrownCodes(() => middleware({ name: "x", handle: "no" as never }))).toEqual(["HOLQA_DECLARATION_INVALID"]);
    expect(thrownCodes(() => http.api({ id: "bad", basePath: "/", middleware: "auth" as never }))).toEqual(["HOLQA_DECLARATION_INVALID"]);
    expect(thrownCodes(() => defineApp({ name: "bad", resources: {}, middleware: [{ name: "fake", handle: () => undefined }] as never }))).toEqual(["HOLQA_DECLARATION_INVALID"]);
    expect(Object.isFrozen(authenticate)).toBe(true);
  });

  it("gives middleware the invocation's identifiers and a scope that fails outside a runtime", async () => {
    const seen: string[] = [];
    const inspect = middleware({ name: "inspect", handle: async ({ invocationId, correlationId, scope, next }) => {
      seen.push(invocationId, correlationId);
      await expect(scope.use({ name: "pool", create: () => 1 })).rejects.toThrow("outside a runtime");
      return next();
    } });
    const route = owned(http.api({ id: "ids-api", basePath: "/" })).route({ id: "ids", method: "GET", path: "/", middleware: [inspect], responses: { 200: z.string() }, handler: ({ reply }) => reply(200, "ok") });
    await invokeHttp(route, new Request("http://localhost/"));
    await invokeHttp(route, new Request("http://localhost/"), { correlationId: "corr-7" });
    expect(seen).toEqual(["inv-1", "inv-1", "inv-1", "corr-7"]);
  });
});