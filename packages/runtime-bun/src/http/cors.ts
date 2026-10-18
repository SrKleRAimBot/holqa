import {
  createDiagnostic,
  diagnosticCodes,
  HolqaError
} from "@holqa/core";

/**
 * Cross-origin resource sharing for browser callers. Without it, the runtime
 * adds no CORS headers and browsers block cross-origin calls.
 */
export interface CorsOptions {
  /** Allowed origins: `"*"`, a list of exact origins such as `https://app.example.com`, or a predicate. */
  readonly origins: "*" | readonly string[] | ((origin: string) => boolean);
  /** Request headers browsers may send; defaults to echoing the headers a preflight asks for. */
  readonly allowHeaders?: readonly string[];
  /** Response headers browser code may read, in addition to `x-correlation-id`. */
  readonly exposeHeaders?: readonly string[];
  /** Whether browsers may send cookies and authorization headers. Not allowed with `origins: "*"`. */
  readonly credentials?: boolean;
  /** How long browsers may cache a preflight answer, in seconds. */
  readonly maxAgeSeconds?: number;
}

/** A validated CORS policy. */
export class CorsPolicy {
  /** The policy's settings. */
  private readonly options: CorsOptions;

  /**
   * Validates CORS settings.
   *
   * @param options - The settings.
   * @throws {HolqaError} `HOLQA_RUNTIME_START_FAILED` when credentials are combined with every origin, or a setting is malformed.
   */
  constructor(options: CorsOptions) {
    const problems: string[] = [];
    const { origins } = options;
    if (origins !== "*" && typeof origins !== "function" && (!Array.isArray(origins) || origins.some(origin => typeof origin !== "string" || origin === "*")))
      problems.push("\"cors.origins\" must be \"*\", a list of origins or a function.");
    if (options.credentials === true && origins === "*")
      problems.push("\"cors.credentials\" cannot be combined with \"cors.origins\": \"*\"; list the allowed origins instead.");
    if (options.maxAgeSeconds !== undefined && (!Number.isSafeInteger(options.maxAgeSeconds) || options.maxAgeSeconds < 0))
      problems.push("\"cors.maxAgeSeconds\" must be a non-negative integer.");
    if (problems.length > 0)
      throw new HolqaError(problems.map(message => createDiagnostic({ code: diagnosticCodes.runtimeStartFailed, severity: "error", message })));
    this.options = options;
  }

  /**
   * Reports whether an origin may call the application.
   *
   * @param origin - The request's `origin` header.
   * @returns `true` when the policy allows it.
   */
  allows(origin: string): boolean {
    const { origins } = this.options;
    return origins === "*" || (typeof origins === "function" ? origins(origin) : origins.includes(origin));
  }

  /**
   * Returns the headers for a response to an allowed origin.
   *
   * @param origin - The request's `origin` header.
   * @returns CORS response headers; only `vary: origin` (or nothing, for `"*"`) when the origin is not allowed.
   */
  responseHeaders(origin: string | null): Record<string, string> {
    const wildcard = this.options.origins === "*";
    if (origin === null || !this.allows(origin)) {
      // The answer depends on the origin, so caches must key on it even when no CORS headers are sent.
      return wildcard ? {} : { vary: "origin" };
    }
    return {
      "access-control-allow-origin": wildcard ? "*" : origin,
      "access-control-expose-headers": ["x-correlation-id", ...this.options.exposeHeaders ?? []].join(", "),
      ...wildcard ? {} : { vary: "origin" },
      ...this.options.credentials === true ? { "access-control-allow-credentials": "true" } : {}
    };
  }

  /**
   * Returns the headers that answer a preflight request.
   *
   * @param request - The `OPTIONS` request.
   * @param methods - The methods the requested path serves.
   * @returns The preflight headers; empty when the origin is not allowed.
   */
  preflightHeaders(request: Request, methods: readonly string[]): Record<string, string> {
    const origin = request.headers.get("origin");
    if (origin === null || !this.allows(origin))
      return this.responseHeaders(origin);
    const headers = this.responseHeaders(origin);
    const requested = request.headers.get("access-control-request-headers");
    const allowHeaders = this.options.allowHeaders?.join(", ") ?? requested;
    return {
      ...headers,
      "access-control-allow-methods": methods.join(", "),
      ...allowHeaders === null || allowHeaders === "" ? {} : { "access-control-allow-headers": allowHeaders },
      ...this.options.maxAgeSeconds === undefined ? {} : { "access-control-max-age": String(this.options.maxAgeSeconds) },
      "vary": "origin, access-control-request-method, access-control-request-headers"
    };
  }
}

/**
 * Reports whether a request is a CORS preflight.
 *
 * @param request - The incoming request.
 * @returns `true` for an `OPTIONS` request with `origin` and `access-control-request-method` headers.
 */
export function isPreflight(request: Request): boolean {
  return request.method === "OPTIONS" && request.headers.has("origin") && request.headers.has("access-control-request-method");
}