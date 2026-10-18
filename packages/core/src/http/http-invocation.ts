/**
 * What a runtime passes as the `input` of an `http.route` or
 * `http.procedure` handler's `invoke`: the incoming Fetch `Request` and the
 * path parameters the runtime's router extracted from its URL. Both are
 * untrusted; the handler validates them against its schemas. `invoke`
 * resolves to a Fetch `Response`.
 */
export interface HttpInvocationInput {
  readonly request: Request;
  /** Path parameters by name, percent-decoded. Empty for procedures and for routes without parameters. */
  readonly params: Readonly<Record<string, string>>;
}

/**
 * Reports whether a value has the shape of an {@link HttpInvocationInput}.
 * The check is structural so that requests from another realm (a worker or
 * another copy of a runtime) are accepted.
 *
 * @param value - The untrusted `input` a runtime passed to `invoke`.
 * @returns `true` when the value carries a request-like object and a record of string parameters.
 */
export function isHttpInvocationInput(value: unknown): value is HttpInvocationInput {
  if (typeof value !== "object" || value === null || !("request" in value) || !("params" in value))
    return false;
  const { request, params } = value;
  return isRequestLike(request)
    && typeof params === "object" && params !== null && !Array.isArray(params)
    && Object.values(params).every(entry => typeof entry === "string");
}

/**
 * Reports whether a value looks like a Fetch `Request`.
 *
 * @param value - The candidate request.
 * @returns `true` for an object with a string `method` and `url` and a `headers` object.
 */
function isRequestLike(value: unknown): value is Request {
  return typeof value === "object" && value !== null
    && "method" in value && typeof value.method === "string"
    && "url" in value && typeof value.url === "string"
    && "headers" in value && typeof value.headers === "object" && value.headers !== null;
}

/**
 * Reports whether a value looks like a Fetch `Response`, also when it comes
 * from another realm.
 *
 * @param value - A value returned by a handler or middleware.
 * @returns `true` for a `Response` instance, or an object with a numeric `status`, a `headers` object with a `get` method, and the `arrayBuffer` body reader.
 */
export function isResponseLike(value: unknown): value is Response {
  if (typeof Response !== "undefined" && value instanceof Response)
    return true;
  return typeof value === "object" && value !== null
    && "status" in value && typeof value.status === "number"
    && "headers" in value && typeof value.headers === "object" && value.headers !== null
    && "get" in value.headers && typeof value.headers.get === "function"
    && "arrayBuffer" in value && typeof value.arrayBuffer === "function";
}