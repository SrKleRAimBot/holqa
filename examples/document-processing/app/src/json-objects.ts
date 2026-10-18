import type { z } from "zod";
import { resources } from "@/app/infra";

/**
 * Reads a JSON object from the bucket and validates it.
 *
 * @param key - The object key.
 * @param schema - The schema the stored JSON must satisfy.
 * @returns The validated value, or `undefined` when the object does not exist.
 */
export async function readJson<Schema extends z.ZodType>(key: string, schema: Schema): Promise<z.output<Schema> | undefined> {
  const bytes = await resources.files.get(key);
  return bytes === undefined ? undefined : schema.parse(JSON.parse(new TextDecoder().decode(bytes)));
}

/**
 * Writes a value to the bucket as JSON.
 *
 * @param key - The object key.
 * @param value - Any JSON value.
 * @returns A promise that settles once the object is stored.
 */
export async function writeJson(key: string, value: unknown): Promise<void> {
  await resources.files.put(key, JSON.stringify(value), { contentType: "application/json" });
}