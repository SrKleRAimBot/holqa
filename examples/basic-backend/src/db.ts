// Illustrative example: uses the proposed Holqa API, which is not implemented yet. This file is not type-checked or executed.
import { SQL } from "bun";

import { config } from "../infra";

/** The shared connection pool, created on first use. */
let pool: SQL | undefined;

/**
 * Returns the shared PostgreSQL connection pool, creating it on first use.
 *
 * Holqa does not provide a database abstraction; applications keep using their
 * own client (Bun SQL, Drizzle, Prisma, ...) and receive the connection string
 * as a validated secret. The pool is created lazily, inside a handler, because
 * the compiler evaluates handler modules without configuration: reading
 * `config.DATABASE_URL` at module top level would fail analysis with
 * `HOLQA_RUNTIME_NOT_BOUND`.
 *
 * @returns The connection pool.
 */
export function getSql(): SQL {
  pool ??= new SQL(config.DATABASE_URL);
  return pool;
}