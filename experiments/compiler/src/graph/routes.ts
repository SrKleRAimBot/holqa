/**
 * Joins an API base path and a route path into one normalized path with a
 * single leading slash, no trailing slash and no empty segments.
 *
 * @param basePath - The API's base path, for example `/api`.
 * @param path - The route path relative to the base path, for example `/orders/:orderId`.
 * @returns The joined path, for example `/api/orders/:orderId`.
 */
export function joinRoutePath(basePath: string, path: string): string {
  const segments = [...basePath.split("/"), ...path.split("/")].filter(segment => segment.length > 0);
  return `/${segments.join("/")}`;
}

/**
 * Reduces a route path to the shape a router matches on: every `:name`
 * parameter segment becomes `:`. Two routes with the same method and shape
 * match exactly the same requests, whatever their parameter names.
 *
 * Static and parameter segments at the same position (`/orders/new` and
 * `/orders/:id`) are not considered ambiguous, because routers conventionally
 * prefer the static segment. That precedence rule must be documented by every
 * runtime driver.
 *
 * @param path - A normalized route path.
 * @returns The path shape, for example `/api/orders/:`.
 */
export function routeShape(path: string): string {
  return path.split("/").map(segment => segment.startsWith(":") ? ":" : segment).join("/");
}