import type { AppDescriptor } from "@/descriptors";

import {
  experimentCodes,
  fail
} from "@/diagnostics";

/** Runtime operations behind a queue handle. Messages are already validated. */
export interface QueueDriver {
  readonly send: (message: unknown) => Promise<void>;
}

/** Runtime operations behind a bucket handle. */
export interface BucketDriver {
  readonly put: (key: string, body: string | Uint8Array, options?: { readonly contentType?: string }) => Promise<void>;
  readonly get: (key: string) => Promise<Uint8Array | undefined>;
}

/**
 * Connects an application's handles to a runtime. A runtime (local emulator,
 * test harness or production driver) supplies one binding per loaded
 * application instance; handles look it up when they are used.
 */
export interface RuntimeBinding {
  readonly queue: (resourceId: string) => QueueDriver;
  readonly bucket: (resourceId: string) => BucketDriver;
  /** Returns the validated value of a configuration entry. */
  readonly config: (name: string) => unknown;
}

/** The mutable slot on an application descriptor that holds its current binding. */
export interface BindingSlot {
  current: RuntimeBinding | undefined;
}

/**
 * Creates an empty binding slot for a new application descriptor.
 *
 * @returns A slot with no binding.
 */
export function createBindingSlot(): BindingSlot {
  return { current: undefined };
}

/**
 * Binds a runtime to an application instance. Rebinding an already-bound
 * application is rejected rather than silently replacing the binding.
 *
 * @param app - The application descriptor.
 * @param binding - The runtime binding to install.
 * @returns A function that removes the binding; calling it twice is harmless.
 * @throws {HolqaError} `HOLQA_DECLARATION_INVALID` when the application is already bound.
 */
export function bindApp(app: AppDescriptor, binding: RuntimeBinding): () => void {
  if (app.binding.current !== undefined)
    fail(experimentCodes.declarationInvalid, `Application "${app.name}" is already bound to a runtime.`, "Unbind the previous runtime first, or load a fresh application instance.");
  app.binding.current = binding;
  return () => {
    if (app.binding.current === binding)
      app.binding.current = undefined;
  };
}

/**
 * Returns the runtime binding of an application, failing clearly when there is none.
 *
 * Handles call this when they are used, not when they are declared, so that
 * importing `infra.ts` stays side-effect free and safe for analysis.
 *
 * @param app - The application descriptor.
 * @param operation - What was attempted, for the error message (for example `resources.orders.send`).
 * @returns The current binding.
 * @throws {HolqaError} `HOLQA_RUNTIME_NOT_BOUND` when no runtime is bound, for example during compilation.
 */
export function requireBinding(app: AppDescriptor, operation: string): RuntimeBinding {
  const binding = app.binding.current;
  if (binding === undefined) {
    fail(
      experimentCodes.runtimeNotBound,
      `${operation} was used while application "${app.name}" is not bound to a runtime.`,
      "Resource handles and configuration only work inside a runtime. Do not use them at module top level; read them inside handlers or lazily."
    );
  }
  return binding;
}