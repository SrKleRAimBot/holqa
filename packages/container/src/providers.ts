import { host } from "@/host";
import { schedules } from "@/schedules";
import { secretFiles } from "@/secret-files";

/** Providers of the conventional Bun container runtime: the execution host, an in-process scheduler and file-based secrets. */
export const container = Object.freeze({ host, schedules, secretFiles });