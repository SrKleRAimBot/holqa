import { env } from "@/apps/invalid/infra";

/** Mistake 3: configuration read at module top level, where no runtime binding exists. */
const connectionString = env.DATABASE_URL;

/** Never reached during analysis. */
export const report = connectionString;