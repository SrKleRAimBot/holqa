import type { CompileApplicationSuccess } from "@/index";

import {
  fixtureAdapter,
  shopFixture
} from "@test/support/application";
import { compileApplication } from "@/index";

/**
 * Compiles the shop fixture, which is known to be valid.
 *
 * @returns The successful compilation.
 * @throws {Error} When compilation fails, which indicates a broken fixture.
 */
export async function compiledShop(): Promise<CompileApplicationSuccess> {
  const result = await compileApplication({ ...shopFixture(), appModule: "infra.ts", runtime: "bun", adapters: [fixtureAdapter] });
  if (!result.ok)
    throw new Error(JSON.stringify(result.diagnostics));
  return result;
}

/**
 * Returns a mutable deep copy of a JSON document, for tampering in tests.
 * Typed `any` on purpose: tests write arbitrary invalid shapes into it, which
 * no precise type would allow.
 *
 * @param value - A manifest, entry point map or other JSON-compatible document.
 * @returns An untyped deep copy.
 */
export function copy(value: unknown): any {
  return JSON.parse(JSON.stringify(value));
}