// The pattern from examples/basic-backend/src/db.ts: a client created at import time from a secret.
import app from "../infra";

/** A stand-in database client configured at module top level. */
export const connection = { url: app.env.DATABASE_URL };