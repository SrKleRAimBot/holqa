import type {
  ApplicationScope,
  HttpInvocationInput,
  InvocationContext,
  InvocationLogger
} from "@holqa/core";

import type { AnyHttpMiddleware } from "@/http/middleware";

import {
  createDiagnostic,
  diagnosticCodes,
  failWith,
  HolqaError,
  isHttpInvocationInput,
  isResponseLike
} from "@holqa/core";

/** What every middleware and the terminal step of the pipeline share for one invocation. */
export interface PipelineArgs {
  readonly request: Request;
  readonly url: URL;
  /** Path parameters extracted by the runtime's router. */
  readonly params: Readonly<Record<string, string>>;
  readonly context: object;
  readonly invocationId: string;
  readonly correlationId: string;
  readonly signal: AbortSignal;
  readonly log: InvocationLogger;
  readonly scope: ApplicationScope;
}

/**
 * A scope for invocations that run outside a runtime, for example a test that
 * calls `invoke` directly. Using it fails clearly instead of creating values
 * that nothing would ever dispose of.
 */
const unavailableScope: ApplicationScope = Object.freeze({
  signal: new AbortController().signal,
  use: async () => failWith(diagnosticCodes.runtimeNotBound, "An application-scoped value was used outside a runtime.", "Run the handler in a runtime such as @holqa/runtime-bun, which provides the application scope.")
});

/**
 * Runs one HTTP invocation through a middleware chain and a terminal step
 * (the route or procedure handler). Middleware runs in list order; each one
 * runs the rest of the chain by calling `next`, may extend the typed context,
 * and may return a different response. Errors propagate outward through the
 * chain unchanged, so the runtime normalizes them once.
 *
 * @param input - The untrusted invocation input from the runtime.
 * @param invocation - The invocation context.
 * @param chain - The middleware, in execution order.
 * @param terminal - Produces the response once every middleware has called `next`.
 * @returns The response of the chain.
 * @throws {HolqaError} `HOLQA_INPUT_INVALID` when the runtime passed no HTTP input, `HOLQA_RESPONSE_INVALID` when a middleware returns something that is not a response; and whatever the chain throws.
 */
export async function runHttpPipeline(input: unknown, invocation: InvocationContext, chain: readonly AnyHttpMiddleware[], terminal: (args: PipelineArgs) => Promise<Response>): Promise<Response> {
  if (!isHttpInvocationInput(input))
    failWith(diagnosticCodes.inputInvalid, "An HTTP handler was invoked without an HTTP request.", "HTTP handlers expect { request, params } from the runtime's router.");
  const { request, params } = input as HttpInvocationInput;
  const base = {
    request,
    url: new URL(request.url),
    params,
    invocationId: invocation.invocationId,
    correlationId: invocation.correlationId ?? invocation.invocationId,
    signal: invocation.signal,
    log: invocation.log,
    scope: invocation.scope ?? unavailableScope
  };

  /**
   * Runs the middleware at one position, or the terminal step after the last.
   *
   * @param index - The position in the chain.
   * @param context - The typed context built so far.
   * @returns The response of the rest of the chain.
   */
  const run = async (index: number, context: object): Promise<Response> => {
    const current = chain[index];
    if (current === undefined)
      return terminal({ ...base, context });
    let called = false;
    /**
     * Runs the rest of the chain with an extended context.
     *
     * @param extension - Properties to add to the context.
     * @returns The rest of the chain's response.
     */
    const next = async (extension?: object): Promise<{ readonly response: Response }> => {
      if (called)
        throw new Error(`Middleware "${current.name}" called next() more than once.`);
      called = true;
      if (extension !== undefined && (typeof extension !== "object" || extension === null || Array.isArray(extension)))
        throw new TypeError(`Middleware "${current.name}" passed a value to next() that is not an object.`);
      const response = await run(index + 1, extension === undefined ? context : Object.freeze({ ...context, ...extension }));
      return Object.freeze({ response });
    };
    const result: unknown = await current.handle({ ...base, context: context as never, next: next as never });
    if (isResponseLike(result))
      return result;
    if (typeof result === "object" && result !== null && "response" in result && isResponseLike(result.response))
      return result.response;
    throw new HolqaError(createDiagnostic({
      code: diagnosticCodes.responseInvalid,
      severity: "error",
      message: `Middleware "${current.name}" returned neither a Response nor the result of next().`,
      hint: "Return the value of await next(...), or a Response to answer early."
    }));
  };
  return run(0, Object.freeze({}));
}