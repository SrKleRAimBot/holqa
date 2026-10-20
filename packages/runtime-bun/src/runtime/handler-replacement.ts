import type { Diagnostic } from "@holqa/core";

import type { RegisteredHandler } from "@/dispatch/dispatcher";
import type { HandlerReplacementEntry } from "@/dispatch/handler-registry";

import {
  createDiagnostic,
  diagnosticCodes,
  getHandlerDescriptor
} from "@holqa/core";

/** How deep {@link definitionShape} follows nested values. */
const maxShapeDepth = 16;

/**
 * Describes a handler definition (or any value) as comparable text: object
 * keys sorted, functions reduced to `"[function]"`, so two definitions with
 * the same trigger, event policy and idempotency policy compare equal even
 * when their key functions are different closures.
 *
 * @param value - A definition or part of one.
 * @param depth - How deep the value is nested.
 * @returns A JSON-compatible description.
 */
function definitionShape(value: unknown, depth = 0): unknown {
  if (typeof value === "function")
    return "[function]";
  if (typeof value !== "object" || value === null || depth >= maxShapeDepth)
    return value;
  if (Array.isArray(value))
    return value.map(entry => definitionShape(entry, depth + 1));
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, definitionShape((value as Readonly<Record<string, unknown>>)[key], depth + 1)]));
}

/**
 * Checks replacement registrations against the registered handlers: every
 * registration must be a handler this runtime can run, name a registered
 * handler at most once, and keep its definition (trigger, event policy,
 * idempotency policy) and schema roles. Schema contents are not compared:
 * the caller (for example `holqa dev`, through the compiler) checks that
 * contracts did not change.
 *
 * @param handlers - The registered handlers by identifier.
 * @param registrations - The replacement registrations, unvalidated.
 * @param sources - Where each replacement is implemented, by identifier.
 * @returns The replacement entries, or every problem found.
 */
export function checkReplacements(handlers: ReadonlyMap<string, RegisteredHandler>, registrations: readonly unknown[], sources: Readonly<Record<string, string>> | undefined): { readonly entries: readonly HandlerReplacementEntry[]; readonly problems: readonly Diagnostic[] } {
  const problems: Diagnostic[] = [];
  const entries: HandlerReplacementEntry[] = [];
  /**
   * Records one problem.
   *
   * @param message - What is wrong.
   * @param handlerId - The handler concerned, when known.
   */
  const report = (message: string, handlerId?: string): void => {
    problems.push(createDiagnostic({
      code: diagnosticCodes.handlerReplacementInvalid,
      severity: "error",
      message,
      hint: "Only a handler's implementation can be replaced in place; restart the application to change definitions.",
      ...handlerId === undefined ? {} : { details: { handler: handlerId } }
    }));
  };
  if (!Array.isArray(registrations)) {
    report("The replacement must be a list of handler registrations.");
    return { entries, problems };
  }
  const seen = new Set<string>();
  for (const [index, registration] of registrations.entries()) {
    const descriptor = getHandlerDescriptor(registration);
    if (descriptor === undefined) {
      report(`Replacement ${index} is not a Holqa handler registration this version can run.`);
      continue;
    }
    const { definition } = descriptor;
    const registered = handlers.get(definition.id);
    if (registered === undefined) {
      report(`No handler "${definition.id}" is registered; a replacement cannot add handlers.`, definition.id);
      continue;
    }
    if (seen.has(definition.id)) {
      report(`The replacement lists the handler "${definition.id}" more than once.`, definition.id);
      continue;
    }
    seen.add(definition.id);
    if (JSON.stringify(definitionShape(definition)) !== JSON.stringify(definitionShape(registered.definition))) {
      report(`The definition of handler "${definition.id}" (trigger, event policy or idempotency) differs from the registered one.`, definition.id);
      continue;
    }
    const roles = Object.keys(descriptor.schemas).sort().join(",");
    if (roles !== Object.keys(registered.schemas).sort().join(",")) {
      report(`The handler "${definition.id}" declares other schemas than the registered one.`, definition.id);
      continue;
    }
    const source = sources?.[definition.id];
    entries.push({ handlerId: definition.id, invoke: descriptor.invoke as RegisteredHandler["invoke"], ...typeof source === "string" ? { source } : {} });
  }
  return { entries, problems };
}