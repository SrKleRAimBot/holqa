import type { AppDescriptor } from "@holqa/experiment-model";

import {
  experimentCodes,
  fail
} from "@holqa/experiment-model";

/** Which application each resource handle belongs to. Set once by `defineApp`. */
const owners = new WeakMap<object, AppDescriptor>();

/**
 * Records that a resource handle belongs to an application.
 *
 * @param handle - The resource handle.
 * @param app - The application descriptor created by `defineApp`.
 * @throws {HolqaError} `HOLQA_DECLARATION_INVALID` when the handle already belongs to another application.
 */
export function attachOwner(handle: object, app: AppDescriptor): void {
  const existing = owners.get(handle);
  if (existing !== undefined && existing !== app)
    fail(experimentCodes.declarationInvalid, `A resource handle cannot belong to both "${existing.name}" and "${app.name}".`, "Declare the resource once per application.");
  owners.set(handle, app);
}

/**
 * Returns the application a handle belongs to.
 *
 * @param handle - The resource handle.
 * @param operation - The attempted operation, for the error message.
 * @returns The owning application descriptor.
 * @throws {HolqaError} `HOLQA_RUNTIME_NOT_BOUND` when the handle was never passed to `defineApp`.
 */
export function ownerOf(handle: object, operation: string): AppDescriptor {
  const app = owners.get(handle);
  if (app === undefined)
    fail(experimentCodes.runtimeNotBound, `${operation} was used on a resource that is not part of any application.`, "Pass the resource to defineApp before using it.");
  return app;
}