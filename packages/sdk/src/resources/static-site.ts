import type { ResourceDescriptorOf } from "@holqa/core";

import type { ResourceHandle } from "@/resources/handle";
import type { CheckResourceId } from "@/types/checks";

import {
  descriptorKey,
  descriptorProtocol
} from "@holqa/core";

import {
  DeclarationProblems,
  freezeJson,
  requireOptions
} from "@/internal/declaration";

/** `/`, or a path of non-empty segments that starts with `/` and does not end with one. */
const basePathPattern = /^\/$|^(?:\/[\w.~-]+)+$/;

/**
 * Options accepted by {@link staticSite}.
 *
 * @typeParam Id - The literal identifier.
 */
export interface StaticSiteOptions<Id extends string> {
  /** The persistent identity of the site. */
  readonly id: Id;
  /**
   * Where the built artifacts are, relative to the application module's
   * directory, with `/` separators, for example `web/dist`. A frontend build
   * (Vite or another bundler) writes them; Holqa serves them.
   */
  readonly directory: string;
  /** The URL path prefix, for example `/` or `/app`. Default `/`. HTTP API routes take precedence over the site. */
  readonly basePath?: string;
  /**
   * Answer requests for extension-less paths that name no file with the
   * site's `index.html`, so a client-side router can handle them. Default `false`.
   */
  readonly spa?: boolean;
}

/**
 * A typed handle to a declared static site. Sites have no operations; a
 * binding serves their files.
 *
 * @typeParam Id - The literal identifier.
 */
export interface StaticSiteHandle<Id extends string> extends ResourceHandle<"static.site", Id> {}

/**
 * Declares a static frontend: built files served under a base path, next to
 * the application's HTTP APIs. Pure: reads no files and creates no
 * infrastructure; the directory need not exist until the site is served.
 *
 * @example
 * ```ts
 * export const web = staticSite({ id: "web", directory: "web/dist", spa: true });
 * ```
 *
 * @param options - Identifier, artifact directory, base path and fallback.
 * @returns A typed static site handle.
 * @throws {HolqaError} `HOLQA_RESOURCE_ID_INVALID` for an invalid identifier, or `HOLQA_DECLARATION_INVALID` for a malformed option.
 */
export function staticSite<const Id extends string>(options: StaticSiteOptions<Id> & CheckResourceId<Id>): StaticSiteHandle<Id> {
  const raw = requireOptions(options, "staticSite");
  const problems = new DeclarationProblems(`staticSite "${String(raw.id)}"`);
  const idCandidate = problems.identifier(raw.id, "site id");
  const directory = raw.directory;
  if (typeof directory !== "string" || directory === "" || directory.startsWith("/") || directory.includes("\\") || /^[a-z]:/i.test(directory) || directory.split("/").some(segment => segment === ".." || segment === "." || segment === ""))
    problems.invalid("\"directory\" must be a relative path with \"/\" separators inside the application, such as \"web/dist\", without \".\", \"..\" or empty segments.");
  const basePath = raw.basePath ?? "/";
  if (typeof basePath !== "string" || !basePathPattern.test(basePath))
    problems.invalid("\"basePath\" must be \"/\" or a path such as \"/app\" that starts with \"/\" and does not end with one.");
  if (raw.spa !== undefined && typeof raw.spa !== "boolean")
    problems.invalid("\"spa\" must be a boolean.");
  const id = problems.valid(idCandidate);
  const descriptor: ResourceDescriptorOf<"static.site"> = Object.freeze({
    protocol: descriptorProtocol,
    type: "resource",
    kind: "static.site",
    id,
    config: freezeJson({ directory: options.directory, basePath: options.basePath ?? "/" }),
    requirements: freezeJson({ spaFallback: options.spa === true }),
    schemas: Object.freeze({})
  });
  return Object.freeze({ [descriptorKey]: descriptor, kind: "static.site" as const, id: options.id });
}