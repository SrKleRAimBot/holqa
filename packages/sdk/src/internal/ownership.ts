import type { AppDescriptor } from "@holqa/core";

import {
  diagnosticCodes,
  failWith
} from "@holqa/core";

/**
 * Which application instance each resource handle belongs to. Written once by
 * `defineApp`. The map is private to this copy of the SDK, so a handle created
 * by one copy and passed to `defineApp` from another copy is not found here;
 * applications must load a single copy of `@holqa/sdk` (ADR 0020).
 */
const owners = new WeakMap<object, AppDescriptor>();

/**
 * Returns the application a handle already belongs to.
 *
 * @param handle - A resource handle.
 * @returns The owning application descriptor, or `undefined` before `defineApp` has claimed the handle.
 */
export function currentOwner(handle: object): AppDescriptor | undefined {
  return owners.get(handle);
}

/**
 * Records that a resource handle belongs to an application instance. Callers
 * check {@link currentOwner} first, so ownership is never reassigned.
 *
 * @param handle - A resource handle.
 * @param app - The application descriptor created by `defineApp`.
 */
export function claim(handle: object, app: AppDescriptor): void {
  owners.set(handle, app);
}

/**
 * Returns the application a handle belongs to, so that an operation can find
 * the application's runtime binding.
 *
 * @param handle - A resource handle.
 * @param operation - The attempted operation, for the error message.
 * @returns The owning application descriptor.
 * @throws {HolqaError} `HOLQA_DECLARATION_INVALID` when the handle was never passed to `defineApp`.
 */
export function ownerOf(handle: object, operation: string): AppDescriptor {
  const app = owners.get(handle);
  if (app === undefined)
    failWith(diagnosticCodes.declarationInvalid, `${operation} was used on a resource that is not part of any application.`, "Pass the resource to defineApp before using it.");
  return app;
}