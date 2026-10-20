import type { Diagnostic } from "@holqa/core";

import { createHash } from "node:crypto";
import {
  readFile,
  stat
} from "node:fs/promises";
import {
  isAbsolute,
  join,
  normalize,
  sep
} from "node:path";

import {
  createDiagnostic,
  diagnosticCodes,
  HolqaError
} from "@holqa/core";

/** The format tag of a deployment artifact's descriptor, `artifact.json`. */
export const artifactFormat = "holqa.artifact/1";

/** The descriptor's file name in an artifact directory. */
export const artifactFileName = "artifact.json";

/** One file of an artifact and its content hash. */
export interface ArtifactFile {
  /** The path relative to the artifact directory, with `/` separators. */
  readonly path: string;
  /** The lowercase hex SHA-256 of the file's bytes. */
  readonly sha256: string;
  readonly bytes: number;
}

/**
 * The descriptor of a deployment artifact (`artifact.json`), written by
 * `holqa package`: what the artifact runs, what it was resolved against and
 * the hash of every file, so a container can refuse an incomplete or altered
 * artifact before it starts.
 */
export interface ArtifactDescriptor {
  readonly format: typeof artifactFormat;
  readonly application: string;
  /** The application manifest's `sha256:` fingerprint. */
  readonly manifest: string;
  /** The binding configuration's name. */
  readonly bindings: string;
  /** The bundled entry point, relative to the artifact directory: `server.js`. */
  readonly entry: string;
  /** The runtime the artifact needs: the minimum Bun version. */
  readonly runtime: { readonly bun: string };
  /** The static sites copied into the artifact, by identifier, with their directories relative to the artifact. */
  readonly staticSites: readonly { readonly id: string; readonly directory: string }[];
  /** Every file except the descriptor, sorted by path. */
  readonly files: readonly ArtifactFile[];
}

/** A verified artifact: its descriptor and parsed manifests. */
export interface VerifiedArtifact {
  readonly directory: string;
  readonly descriptor: ArtifactDescriptor;
  /** `manifest.json`, parsed. */
  readonly manifest: unknown;
  /** `bindings.json`, parsed. */
  readonly bindingManifest: unknown;
}

/**
 * Computes the SHA-256 of bytes.
 *
 * @param bytes - The content.
 * @returns The lowercase hex digest.
 */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Builds an `HOLQA_ARTIFACT_INVALID` diagnostic.
 *
 * @param message - What is wrong.
 * @param details - Machine-readable details.
 * @returns The diagnostic.
 */
function invalid(message: string, details?: Readonly<Record<string, string>>): Diagnostic {
  return createDiagnostic({ code: diagnosticCodes.artifactInvalid, severity: "error", message, hint: "Package the application again with holqa package and deploy the whole output directory unchanged.", ...details === undefined ? {} : { details } });
}

/**
 * Reports whether a descriptor path stays inside the artifact directory.
 *
 * @param path - A path from the descriptor.
 * @returns `true` for a relative path without `..` segments.
 */
function isContained(path: string): boolean {
  return path !== "" && !isAbsolute(path) && !normalize(path).split(sep).includes("..");
}

/**
 * Reads and checks a descriptor's shape: untrusted JSON from disk.
 *
 * @param value - The parsed `artifact.json`.
 * @returns The descriptor, or the problem.
 */
function readDescriptor(value: unknown): ArtifactDescriptor | string {
  if (typeof value !== "object" || value === null)
    return "artifact.json is not an object";
  const candidate = value as Partial<Record<keyof ArtifactDescriptor, unknown>>;
  if (candidate.format !== artifactFormat)
    return `artifact.json has the format ${JSON.stringify(candidate.format)}, not ${artifactFormat}`;
  for (const field of ["application", "manifest", "bindings", "entry"] as const) {
    if (typeof candidate[field] !== "string")
      return `artifact.json lacks "${field}"`;
  }
  if (typeof (candidate.runtime as { readonly bun?: unknown } | undefined)?.bun !== "string")
    return "artifact.json lacks \"runtime.bun\"";
  if (!Array.isArray(candidate.staticSites) || !candidate.staticSites.every((site: { readonly id?: unknown; readonly directory?: unknown }) => typeof site?.id === "string" && typeof site.directory === "string"))
    return "artifact.json has malformed \"staticSites\"";
  if (!Array.isArray(candidate.files) || !candidate.files.every((file: Partial<Record<keyof ArtifactFile, unknown>>) => typeof file?.path === "string" && isContained(file.path) && typeof file.sha256 === "string" && /^[0-9a-f]{64}$/.test(file.sha256) && typeof file.bytes === "number"))
    return "artifact.json has malformed \"files\"";
  return value as ArtifactDescriptor;
}

/**
 * Compares two dotted version numbers.
 *
 * @param left - A version such as `1.3.13`.
 * @param right - Another version.
 * @returns A negative number when `left` is older, zero when equal, positive when newer.
 */
function compareVersions(left: string, right: string): number {
  const a = left.split(/[.+-]/).map(Number);
  const b = right.split(/[.+-]/).map(Number);
  for (let index = 0; index < 3; index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0)
      return difference;
  }
  return 0;
}

/**
 * Verifies a deployment artifact before anything of it runs: the descriptor's
 * shape, that every listed file exists with its recorded size and SHA-256
 * hash, that the entry point and both manifests are among them, and that the
 * running Bun is at least the version the artifact needs. Files not listed
 * (for example state a provider writes) are ignored.
 *
 * @param directory - Where the artifact's files are, as written by `holqa package`.
 * @param bunVersion - The running Bun's version.
 * @returns The descriptor and parsed manifests.
 * @throws {HolqaError} `HOLQA_ARTIFACT_INVALID` listing every problem.
 */
export async function verifyArtifact(directory: string, bunVersion: string): Promise<VerifiedArtifact> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(join(directory, artifactFileName), "utf8"));
  } catch (error) {
    throw new HolqaError(invalid(`The artifact descriptor ${artifactFileName} cannot be read: ${error instanceof Error ? error.message : String(error)}.`));
  }
  const descriptor = readDescriptor(raw);
  if (typeof descriptor === "string")
    throw new HolqaError(invalid(`The artifact is malformed: ${descriptor}.`));
  const problems: Diagnostic[] = [];
  const contents = new Map<string, Uint8Array>();
  for (const file of descriptor.files) {
    const path = join(directory, file.path);
    const size = (await stat(path).catch(() => undefined))?.size;
    if (size === undefined) {
      problems.push(invalid(`The artifact file ${file.path} is missing.`, { file: file.path }));
      continue;
    }
    const bytes = size === file.bytes ? new Uint8Array(await readFile(path)) : undefined;
    if (bytes === undefined || sha256Hex(bytes) !== file.sha256) {
      problems.push(invalid(`The artifact file ${file.path} was changed after packaging.`, { file: file.path }));
      continue;
    }
    contents.set(file.path, bytes);
  }
  for (const required of [descriptor.entry, "manifest.json", "bindings.json"]) {
    if (!descriptor.files.some(file => file.path === required))
      problems.push(invalid(`The artifact does not list ${required}.`, { file: required }));
  }
  if (compareVersions(bunVersion, descriptor.runtime.bun) < 0)
    problems.push(invalid(`The artifact needs Bun ${descriptor.runtime.bun} or newer, but this is Bun ${bunVersion}.`, { requirement: "runtime.bun" }));
  if (problems.length > 0)
    throw new HolqaError(problems);
  /**
   * Parses a verified JSON file.
   *
   * @param path - The file's path in the artifact.
   * @returns The parsed value.
   */
  const json = (path: string): unknown => JSON.parse(new TextDecoder().decode(contents.get(path)));
  try {
    return Object.freeze({ directory, descriptor, manifest: json("manifest.json"), bindingManifest: json("bindings.json") });
  } catch (error) {
    throw new HolqaError(invalid(`An artifact manifest is not JSON: ${error instanceof Error ? error.message : String(error)}.`));
  }
}