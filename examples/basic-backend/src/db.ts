// Illustrative example: uses the proposed Holqa API, which is not implemented yet. This file is not type-checked or executed.
import { SQL } from "bun";

import { config } from "../infra";

/**
 * Shared PostgreSQL connection pool. Holqa does not provide a database
 * abstraction; applications keep using their own client (Bun SQL, Drizzle,
 * Prisma, ...) and receive the connection string as a validated secret.
 */
export const sql = new SQL(config.DATABASE_URL);