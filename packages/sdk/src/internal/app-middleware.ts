import type { AppDescriptor } from "@holqa/core";

import type { AnyHttpMiddleware } from "@/http/middleware";

/**
 * Application-level HTTP middleware by application instance. Written once by
 * `defineApp` and read by route and procedure invocations, so middleware runs
 * without the core descriptor protocol having to model executable middleware.
 */
const middlewareByApp = new WeakMap<AppDescriptor, readonly AnyHttpMiddleware[]>();

/**
 * Records an application's HTTP middleware.
 *
 * @param app - The application descriptor created by `defineApp`.
 * @param middleware - The middleware, in execution order.
 */
export function setAppMiddleware(app: AppDescriptor, middleware: readonly AnyHttpMiddleware[]): void {
  middlewareByApp.set(app, middleware);
}

/**
 * Returns an application's HTTP middleware.
 *
 * @param app - The application descriptor.
 * @returns The middleware in execution order; empty when the application declares none.
 */
export function appMiddlewareOf(app: AppDescriptor): readonly AnyHttpMiddleware[] {
  return middlewareByApp.get(app) ?? [];
}