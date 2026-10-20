import type {
  ResourceDescriptorOf,
  StaticSiteDriver
} from "@holqa/core";

import { statSync } from "node:fs";
import {
  extname,
  join,
  normalize,
  resolve,
  sep
} from "node:path";

/** Content types by file extension, for the files static sites usually contain. Anything else is served as bytes. */
const contentTypes: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
  ".webmanifest": "application/manifest+json",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".wasm": "application/wasm",
  ".pdf": "application/pdf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg"
};

/**
 * Returns the content type of a file by its extension.
 *
 * @param file - The file name or path.
 * @returns The content type, `application/octet-stream` for unknown extensions.
 */
export function contentTypeOf(file: string): string {
  return contentTypes[extname(file).toLowerCase()] ?? "application/octet-stream";
}

/**
 * Reports whether a path names a regular file.
 *
 * @param path - An absolute path.
 * @returns `true` for an existing regular file.
 */
function isFile(path: string): boolean {
  return statSync(path, { throwIfNoEntry: false })?.isFile() === true;
}

/**
 * Creates the local static site driver: files from each site's directory,
 * resolved against the application root. Paths are decoded and normalized,
 * and any path that would leave the site's directory is refused. A directory
 * path serves its `index.html`; with `spaFallback`, an extension-less path
 * that names no file serves the site's root `index.html`. HTML is sent with
 * `cache-control: no-cache` so new deployments are picked up at once.
 *
 * @param root - The application root the sites' directories are relative to.
 * @returns The driver factory.
 */
export function createLocalStaticSites(root: string): (resource: ResourceDescriptorOf<"static.site">) => StaticSiteDriver {
  return (resource) => {
    const directory = resolve(root, resource.config.directory);
    /**
     * Builds the response for one file.
     *
     * @param file - The file's absolute path.
     * @param request - The request, for `HEAD`.
     * @returns The response.
     */
    const respond = (file: string, request: Request): Response => {
      const type = contentTypeOf(file);
      const headers: Record<string, string> = { "content-type": type, "x-content-type-options": "nosniff" };
      if (type.startsWith("text/html"))
        headers["cache-control"] = "no-cache";
      const body = Bun.file(file);
      return new Response(request.method === "HEAD" ? null : body, { headers: { ...headers, "content-length": String(body.size) } });
    };
    return Object.freeze({
      fetch: async (path: string, request: Request) => {
        let decoded: string;
        try {
          decoded = decodeURIComponent(path);
        } catch {
          // A malformed percent-encoding names no file.
          return undefined;
        }
        if (decoded.includes("\0"))
          return undefined;
        const target = normalize(join(directory, decoded));
        if (target !== directory && !target.startsWith(`${directory}${sep}`))
          return undefined;
        if (isFile(target))
          return respond(target, request);
        const index = join(target, "index.html");
        if (isFile(index))
          return respond(index, request);
        const fallback = join(directory, "index.html");
        if (resource.requirements.spaFallback && extname(decoded) === "" && isFile(fallback))
          return respond(fallback, request);
        return undefined;
      }
    });
  };
}