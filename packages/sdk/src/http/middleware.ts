import type {
  ApplicationScope,
  InvocationLogger,
  InvocationTelemetry
} from "@holqa/core";

import type { HolqaTypeError } from "@/types/checks";

import {
  DeclarationProblems,
  requireOptions
} from "@/internal/declaration";

/** The marker that identifies middleware created by {@link middleware}, checked when middleware is attached. */
export const middlewareMarker = "~holqa.middleware";

/**
 * What a middleware's `next` resolves to: the response produced by the rest
 * of the chain. Return it unchanged, return it with a different `response`, or
 * return a new `Response` instead. The extension type is a phantom: it carries
 * the context the middleware added, so later middleware and handlers see it.
 *
 * @typeParam Extension - The context the middleware passed to `next`.
 */
export interface MiddlewareResult<Extension extends object> {
  readonly "response": Response;
  /** Phantom type carrier; never present at run time. */
  readonly "~extension"?: Extension;
}

/**
 * Runs the rest of the chain. Pass an object to add properties to the typed
 * context that later middleware and the handler receive; a property with an
 * existing name replaces the earlier value. Call it at most once.
 *
 * The added context is typed from the value the middleware returns, so
 * return the result of `next` (or a copy of it with another `response`, for
 * example `{ ...result, response }`); returning a new `Response` instead
 * types the middleware as adding nothing.
 */
export interface MiddlewareNext {
  /** Runs the rest of the chain without adding context. */
  (): Promise<MiddlewareResult<{}>>;
  /** Runs the rest of the chain with added context. */
  <Extension extends object>(extension: Extension): Promise<MiddlewareResult<Extension>>;
}

/**
 * What a middleware receives.
 *
 * @typeParam Context - The typed context built by earlier middleware.
 */
export interface MiddlewareArgs<Context extends object> {
  /** The incoming request. Its body is unread; a handler with a `body` schema reads it after the middleware chain. */
  readonly request: Request;
  readonly url: URL;
  readonly context: Readonly<Context>;
  readonly invocationId: string;
  /** Groups related invocations; equal to `invocationId` when the caller provided none. */
  readonly correlationId: string;
  /** Aborted when the invocation is cancelled, times out or the runtime stops. */
  readonly signal: AbortSignal;
  readonly log: InvocationLogger;
  /** The invocation's telemetry trace context, for example to pass a `traceparent` header to an outgoing call. Absent when the runtime records no telemetry. */
  readonly telemetry?: InvocationTelemetry;
  /** Application-scoped values such as connection pools. */
  readonly scope: ApplicationScope;
  readonly next: MiddlewareNext;
}

/**
 * What a middleware returns: the result of `next` (possibly with a different
 * response), or a `Response` that short-circuits the rest of the chain.
 *
 * @typeParam Extension - The context the middleware added.
 */
export type MiddlewareReturn<Extension extends object> = Response | MiddlewareResult<Extension> | Promise<Response | MiddlewareResult<Extension>>;

/**
 * Options accepted by {@link middleware}.
 *
 * @typeParam Requires - Context earlier middleware must have added.
 * @typeParam Extension - Context this middleware adds through `next`.
 */
export interface MiddlewareOptions<Requires extends object, Extension extends object> {
  /** A short name used in logs, for example `authenticate`. */
  readonly name: string;
  /**
   * Runs around the rest of the chain. Errors thrown by later middleware or
   * the handler propagate through `await next()`, so `try`/`finally` is the
   * place for per-invocation cleanup.
   */
  readonly handle: (args: MiddlewareArgs<Requires>) => MiddlewareReturn<Extension>;
}

/**
 * HTTP middleware that can be attached to an application, an API, a route or
 * a procedure.
 *
 * @typeParam Requires - Context earlier middleware must have added.
 * @typeParam Extension - Context this middleware adds for later middleware and the handler.
 */
export interface HttpMiddleware<Requires extends object, Extension extends object> {
  readonly [middlewareMarker]: 1;
  readonly "name": string;
  readonly "handle": (args: MiddlewareArgs<Requires>) => MiddlewareReturn<Extension>;
  /**
   * Phantom type carrier; never present at run time. `requires` is a function
   * parameter so that middleware requiring more context is still assignable
   * to {@link AnyHttpMiddleware}.
   */
  readonly "~types"?: { readonly requires: (context: Requires) => void; readonly extension: Extension };
}

/** Any middleware, used as a constraint. */
export type AnyHttpMiddleware = HttpMiddleware<never, object>;

/**
 * Merges a context extension into a context: properties of the extension
 * replace properties of the same name.
 *
 * @typeParam Context - The existing context.
 * @typeParam Extension - The added properties.
 */
export type ExtendContext<Context extends object, Extension extends object> = [keyof Extension] extends [never]
  ? Context
  : Simplify<Readonly<Omit<Context, keyof Extension>> & Readonly<Extension>>;

/** Flattens an intersection into one object type, keeping optional and readonly modifiers. */
type Simplify<Value> = { [Key in keyof Value]: Value[Key] };

/**
 * The context a handler receives after a chain of middleware has run on top of `Base`.
 *
 * @typeParam Base - The context before the chain.
 * @typeParam Chain - The middleware, in execution order.
 */
export type MiddlewareChainContext<Base extends object, Chain extends readonly AnyHttpMiddleware[]> = Chain extends readonly [infer Head, ...infer Tail extends readonly AnyHttpMiddleware[]]
  ? MiddlewareChainContext<ExtendContext<Base, MiddlewareExtension<Head>>, Tail>
  : Base;

/** The context a middleware adds. */
export type MiddlewareExtension<Middleware> = Middleware extends { readonly "~types"?: { readonly extension: infer Extension extends object } } ? Extension : {};

/** The context a middleware requires. */
export type MiddlewareRequirement<Middleware> = Middleware extends { readonly "~types"?: { readonly requires: (context: infer Requires extends object) => void } } ? Requires : {};

/**
 * Resolves to `unknown` when every middleware of a chain finds the context it
 * requires, given the context before the chain, and to a readable error type
 * naming the missing properties otherwise.
 *
 * @typeParam Base - The context before the chain.
 * @typeParam Chain - The middleware, in execution order.
 */
export type CheckMiddlewareChain<Base extends object, Chain extends readonly AnyHttpMiddleware[]> = number extends Chain["length"]
  ? true extends RequiresContext<Chain[number]>
    ? HolqaTypeError<"Middleware that requires context must be listed inline (or `as const`), so that its order is known.">
    : unknown
  : Chain extends readonly [infer Head, ...infer Tail extends readonly AnyHttpMiddleware[]]
    ? Base extends MiddlewareRequirement<Head>
      ? CheckMiddlewareChain<ExtendContext<Base, MiddlewareExtension<Head>>, Tail>
      : HolqaTypeError<`A middleware requires context that earlier middleware does not provide: ${Extract<MissingContext<Base, MiddlewareRequirement<Head>>, string>}.`>
    : unknown;

/** Whether any middleware of a union requires context (distributes over the union). */
type RequiresContext<Middleware> = Middleware extends unknown ? [keyof MiddlewareRequirement<Middleware>] extends [never] ? false : true : never;

/** The required keys that a context lacks or holds with an incompatible type. */
type MissingContext<Context, Required> = { [Key in keyof Required]-?: Key extends keyof Context ? Context[Key] extends Required[Key] ? never : Key : Key }[keyof Required];

/** Creates middleware whose required context is fixed by {@link middleware.requires}. */
export type MiddlewareFactory<Requires extends object> = <Extension extends object = {}>(options: MiddlewareOptions<Requires, Extension>) => HttpMiddleware<Requires, Extension>;

/** The {@link middleware} function and its `requires` variant. */
export interface DefineMiddleware {
  /**
   * Defines middleware that needs no context from earlier middleware. The
   * context it adds is inferred from what it passes to `next`.
   *
   * @example
   * ```ts
   * const authenticate = middleware({
   *   name: "authenticate",
   *   handle: async ({ request, next }) => {
   *     const user = await verify(request.headers.get("authorization"));
   *     if (user === undefined)
   *       throw new HttpRejectedError(401, "Sign in to continue.");
   *     return next({ user });
   *   }
   * });
   * ```
   */
  <Extension extends object = {}>(options: MiddlewareOptions<{}, Extension>): HttpMiddleware<{}, Extension>;
  /**
   * Fixes the context a middleware requires from earlier middleware, for
   * example `middleware.requires<{ user: User }>()({ name, handle })`.
   * Attaching it where earlier middleware does not provide that context is a
   * compile error.
   */
  readonly requires: <Requires extends object>() => MiddlewareFactory<Requires>;
}

/**
 * Validates middleware options and creates the middleware value.
 *
 * @param options - The name and the function that runs around the chain.
 * @returns Frozen middleware.
 * @throws {HolqaError} `HOLQA_DECLARATION_INVALID` when the name is empty or `handle` is not a function.
 */
function createMiddleware<Requires extends object, Extension extends object>(options: MiddlewareOptions<Requires, Extension>): HttpMiddleware<Requires, Extension> {
  const raw = requireOptions(options, "middleware");
  const problems = new DeclarationProblems(`middleware "${String(raw.name)}"`);
  if (typeof raw.name !== "string" || raw.name.trim() === "")
    problems.invalid("\"name\" must be a non-empty string.");
  if (typeof raw.handle !== "function")
    problems.invalid("\"handle\" must be a function.");
  problems.throwIfAny();
  return Object.freeze({ [middlewareMarker]: 1 as const, name: options.name, handle: options.handle });
}

/**
 * Defines HTTP middleware. Middleware runs around route and procedure
 * handlers in a fixed order: application middleware, then API middleware,
 * then route or procedure middleware, each in declaration order. It can add
 * typed context, return a response early, change the response, observe
 * errors and clean up.
 */
export const middleware: DefineMiddleware = Object.assign(
  <Extension extends object = {}>(options: MiddlewareOptions<{}, Extension>) => createMiddleware(options),
  { requires: <Requires extends object>(): MiddlewareFactory<Requires> => options => createMiddleware(options) }
);

/**
 * Reports whether a value is middleware created by {@link middleware}.
 *
 * @param value - A candidate from a declaration.
 * @returns `true` for middleware values.
 */
export function isMiddleware(value: unknown): value is AnyHttpMiddleware {
  return typeof value === "object" && value !== null && middlewareMarker in value && (value as Record<string, unknown>)[middlewareMarker] === 1
    && "handle" in value && typeof value.handle === "function";
}

/**
 * Checks an optional `middleware` list in a declaration.
 *
 * @param value - The declared list, unvalidated.
 * @param problems - Where to record problems.
 * @returns A frozen copy of the list; empty when absent or malformed.
 */
export function middlewareList(value: unknown, problems: DeclarationProblems): readonly AnyHttpMiddleware[] {
  if (value === undefined)
    return Object.freeze([]);
  if (!Array.isArray(value)) {
    problems.invalid("\"middleware\" must be a list of middleware.");
    return Object.freeze([]);
  }
  const list: AnyHttpMiddleware[] = [];
  for (const [index, entry] of (value as readonly unknown[]).entries()) {
    if (isMiddleware(entry))
      list.push(entry);
    else
      problems.invalid(`"middleware[${index}]" is not middleware.`, "Create middleware with middleware({ name, handle }).");
  }
  return Object.freeze(list);
}