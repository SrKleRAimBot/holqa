import type {
  ApplicationScope,
  Described,
  HandlerDescriptor,
  InvocationContext
} from "@holqa/core";

import type { AnyResource } from "@/index";

import { getHandlerDescriptor } from "@holqa/core";

import { defineApp } from "@/index";

/** Options of {@link invokeHttp}. */
export interface InvokeHttpOptions {
  readonly params?: Readonly<Record<string, string>>;
  readonly scope?: ApplicationScope;
  readonly correlationId?: string;
}

/**
 * Calls an HTTP handler's `invoke` the way a runtime does, with a fresh
 * signal and silent logging.
 *
 * @param registration - A route or procedure registration.
 * @param request - The request to pass.
 * @param options - Path parameters, an application scope and a correlation identifier.
 * @returns The handler's response.
 * @throws Whatever the handler's invocation throws.
 */
export async function invokeHttp(registration: Described<HandlerDescriptor>, request: Request, options: InvokeHttpOptions = {}): Promise<Response> {
  const descriptor = getHandlerDescriptor(registration);
  if (descriptor === undefined)
    throw new TypeError("Not a handler registration.");
  /** Discards a log entry. */
  const silent = (): void => {};
  const context: InvocationContext = {
    invocationId: "inv-1",
    signal: new AbortController().signal,
    metadata: {},
    log: { info: silent, warn: silent, error: silent },
    ...options.scope === undefined ? {} : { scope: options.scope },
    ...options.correlationId === undefined ? {} : { correlationId: options.correlationId }
  };
  const response = await descriptor.invoke({ request, params: options.params ?? {} }, context as never);
  if (!(response instanceof Response))
    throw new TypeError("The handler did not return a Response.");
  return response;
}

/**
 * Runs an async function that must reject with a Holqa error and returns its diagnostic codes.
 *
 * @param run - The function expected to reject.
 * @returns The codes of the rejection's diagnostics.
 * @throws When the function resolves, or rejects with something other than a Holqa error.
 */
export async function rejectedCodes(run: () => Promise<unknown>): Promise<string[]> {
  try {
    await run();
  } catch (error) {
    if (typeof error === "object" && error !== null && "diagnostics" in error && Array.isArray(error.diagnostics))
      return (error.diagnostics as Array<{ readonly code: string }>).map(diagnostic => diagnostic.code);
    throw error;
  }
  throw new Error("Expected a rejection.");
}

/**
 * Builds a JSON request.
 *
 * @param url - Where the request is sent.
 * @param body - The value to send as JSON.
 * @param method - The HTTP method; `POST` by default.
 * @returns A request with a JSON body and `content-type`.
 */
export function jsonRequest(url: string, body: unknown, method = "POST"): Request {
  return new Request(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

/** Numbers the applications created by {@link owned}. */
let ownedApps = 0;

/**
 * Passes a resource to a fresh application, as every served API must be.
 *
 * @param resource - The resource handle, typically an `http.api`.
 * @returns The same handle, now owned by an application without middleware.
 */
export function owned<Resource extends AnyResource>(resource: Resource): Resource {
  ownedApps += 1;
  defineApp({ name: `test-app-${ownedApps}`, resources: { resource } } as never);
  return resource;
}