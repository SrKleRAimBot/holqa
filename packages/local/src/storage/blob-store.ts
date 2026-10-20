import {
  mkdirSync,
  renameSync,
  rmSync
} from "node:fs";
import { join } from "node:path";

/**
 * Where the local storage keeps object bytes. Metadata, events and
 * deliveries stay in the state database either way; only the bytes move.
 */
export interface BlobStore {
  /** `true` when bytes outlive the process (files), `false` when they live in memory. */
  readonly durable: boolean;
  /** Stores bytes under a blob name in a bucket's space; atomic: a reader never sees part of them. */
  readonly write: (bucketId: string, blob: string, body: Uint8Array) => Promise<void>;
  /** Reads stored bytes. */
  readonly read: (bucketId: string, blob: string) => Promise<Uint8Array>;
  /** Returns stored bytes as a response body, without copying them where possible. */
  readonly body: (bucketId: string, blob: string) => Blob | Uint8Array<ArrayBuffer>;
  /** Removes stored bytes; removing missing bytes is harmless. */
  readonly remove: (bucketId: string, blob: string) => void;
}

/**
 * Keeps object bytes in files under a directory: one directory per bucket,
 * one file per blob, written to a temporary name first and renamed, so a
 * crash never leaves a partly written object.
 *
 * @param directory - The directory, created when missing.
 * @returns A durable blob store.
 */
export function filesystemBlobs(directory: string): BlobStore {
  /**
   * Returns a bucket's directory.
   *
   * @param bucketId - The bucket's logical identifier, a safe path segment.
   * @returns The directory path.
   */
  const folder = (bucketId: string): string => join(directory, bucketId);
  return Object.freeze({
    durable: true,
    write: async (bucketId: string, blob: string, body: Uint8Array) => {
      mkdirSync(folder(bucketId), { recursive: true });
      const temporary = join(folder(bucketId), `${blob}.partial`);
      await Bun.write(temporary, body);
      renameSync(temporary, join(folder(bucketId), blob));
    },
    read: async (bucketId: string, blob: string) => Bun.file(join(folder(bucketId), blob)).bytes(),
    body: (bucketId: string, blob: string) => Bun.file(join(folder(bucketId), blob)),
    remove: (bucketId: string, blob: string) => rmSync(join(folder(bucketId), blob), { force: true })
  });
}

/**
 * Keeps object bytes in memory, for fast, isolated tests. Nothing survives
 * the process.
 *
 * @returns An ephemeral blob store.
 */
export function memoryBlobs(): BlobStore {
  const blobs = new Map<string, Uint8Array>();
  /**
   * Builds the map key of a blob.
   *
   * @param bucketId - The bucket's logical identifier.
   * @param blob - The blob name.
   * @returns A key unique per bucket and blob.
   */
  const keyOf = (bucketId: string, blob: string): string => `${bucketId}/${blob}`;
  /**
   * Reads stored bytes or fails, as a missing file would.
   *
   * @param bucketId - The bucket's logical identifier.
   * @param blob - The blob name.
   * @returns The bytes.
   * @throws {Error} When the blob does not exist, which means the metadata and bytes disagree.
   */
  const stored = (bucketId: string, blob: string): Uint8Array => {
    const found = blobs.get(keyOf(bucketId, blob));
    if (found === undefined)
      throw new Error(`The local blob "${keyOf(bucketId, blob)}" does not exist.`);
    return found;
  };
  return Object.freeze({
    durable: false,
    write: async (bucketId: string, blob: string, body: Uint8Array) => {
      blobs.set(keyOf(bucketId, blob), body.slice());
    },
    read: async (bucketId: string, blob: string) => stored(bucketId, blob).slice(),
    body: (bucketId: string, blob: string) => stored(bucketId, blob).slice(),
    remove: (bucketId: string, blob: string) => {
      blobs.delete(keyOf(bucketId, blob));
    }
  });
}