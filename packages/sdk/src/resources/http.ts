import type {
  HttpApiDocs,
  ResourceDescriptorOf
} from "@holqa/core";

import type { ResourceHandle } from "@/resources/handle";
import type { CheckResourceId } from "@/types/checks";

import {
  descriptorKey,
  descriptorProtocol
} from "@holqa/core";

import {
  DeclarationProblems,
  definedEntries,
  freezeJson,
  optionalObject,
  requireOptions
} from "@/internal/declaration";

/** `/`, or a path of non-empty segments that starts with `/` and does not end with one. */
const basePathPattern = /^\/$|^(?:\/[\w.~-]+)+$/;

/**
 * Options accepted by {@link http.api}.
 *
 * @typeParam Id - The literal identifier.
 */
export interface HttpApiOptions<Id extends string> {
  /** The persistent identity of the API. */
  readonly id: Id;
  /** Path prefix for every route, for example `/api`. */
  readonly basePath: string;
  /** Documentation metadata, for example for generated API descriptions. */
  readonly docs?: HttpApiDocs;
}

/**
 * A typed handle to a declared HTTP API. Route registration and HTTP
 * execution are planned for a later milestone; today the handle declares the
 * API resource only.
 *
 * @typeParam Id - The literal identifier.
 */
export interface HttpApiHandle<Id extends string> extends ResourceHandle<"http.api", Id> {}

/**
 * Declares an HTTP API that routes will be registered against. Pure: opens no
 * port and creates no infrastructure.
 *
 * @param options - Identifier, base path and documentation metadata.
 * @returns A typed API handle.
 * @throws {HolqaError} `HOLQA_RESOURCE_ID_INVALID` for an invalid identifier, or `HOLQA_DECLARATION_INVALID` for a malformed option.
 */
function api<const Id extends string>(options: HttpApiOptions<Id> & CheckResourceId<Id>): HttpApiHandle<Id> {
  const raw = requireOptions(options, "http.api");
  const problems = new DeclarationProblems(`http.api "${String(raw.id)}"`);
  const idCandidate = problems.identifier(raw.id, "api id");
  if (typeof raw.basePath !== "string" || !basePathPattern.test(raw.basePath))
    problems.invalid("\"basePath\" must be \"/\" or a path such as \"/api\" that starts with \"/\" and does not end with one.");
  const docs = optionalObject<HttpApiDocs>(raw.docs, "docs", problems);
  if (raw.docs !== undefined && (typeof docs.title !== "string" || docs.title === "" || typeof docs.version !== "string" || docs.version === ""))
    problems.invalid("\"docs\" must have a non-empty \"title\" and \"version\".");
  const id = problems.valid(idCandidate);

  const descriptor: ResourceDescriptorOf<"http.api"> = Object.freeze({
    protocol: descriptorProtocol,
    type: "resource",
    kind: "http.api",
    id,
    config: freezeJson({
      basePath: options.basePath,
      ...definedEntries({ docs: options.docs === undefined ? undefined : { title: options.docs.title, version: options.docs.version } })
    }),
    requirements: freezeJson({}),
    schemas: Object.freeze({})
  });

  return Object.freeze({
    [descriptorKey]: descriptor,
    kind: "http.api" as const,
    id: options.id
  });
}

/** HTTP resource factories. */
export const http = Object.freeze({ api });