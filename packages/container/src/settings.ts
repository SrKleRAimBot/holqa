import type { Diagnostic } from "@holqa/core";

import {
  createDiagnostic,
  diagnosticCodes,
  HolqaError
} from "@holqa/core";

/** The environment variables a container reads its settings from. */
export type ContainerEnvironment = Readonly<Record<string, string | undefined>>;

/** A container's settings, read from its environment. */
export interface ContainerSettings {
  /** `PORT`; default 3000. `0` picks a free port. */
  readonly port: number;
  /** `HOST`; default `0.0.0.0`, so the port is reachable from outside the container. */
  readonly hostname: string;
  /** `HOLQA_SHUTDOWN_GRACE_MS`: how long in-flight work may finish after a termination signal. Default 10 000. */
  readonly graceMs: number;
  /** `HOLQA_SHUTDOWN_FORCE_MS`: how long to wait after cancelling work that ignores its signal. Default 1 000. */
  readonly forceMs: number;
  /** `HOLQA_MAX_REQUEST_BODY_BYTES`: the largest request body accepted. Default 1 MiB. */
  readonly maxRequestBodySize: number;
}

/** The variables, their defaults and bounds. */
const variables = [
  { name: "PORT", field: "port", fallback: 3_000, min: 0, max: 65_535 },
  { name: "HOLQA_SHUTDOWN_GRACE_MS", field: "graceMs", fallback: 10_000, min: 0, max: 3_600_000 },
  { name: "HOLQA_SHUTDOWN_FORCE_MS", field: "forceMs", fallback: 1_000, min: 0, max: 600_000 },
  { name: "HOLQA_MAX_REQUEST_BODY_BYTES", field: "maxRequestBodySize", fallback: 1024 * 1024, min: 1, max: 2 ** 31 - 1 }
] as const;

/**
 * Reads a container's settings from its environment. Container platforms
 * conventionally set `PORT`; termination grace periods should be shorter than
 * the platform's own grace period before it kills the process.
 *
 * @param env - The process environment.
 * @returns Port, interface, shutdown periods and request size limit, with defaults applied.
 * @throws {HolqaError} `HOLQA_CONTAINER_SETTINGS_INVALID`, one diagnostic per invalid variable.
 */
export function readContainerSettings(env: ContainerEnvironment): ContainerSettings {
  const problems: Diagnostic[] = [];
  const values: Record<string, number> = {};
  for (const variable of variables) {
    const raw = env[variable.name];
    if (raw === undefined || raw === "") {
      values[variable.field] = variable.fallback;
      continue;
    }
    const value = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
    if (!Number.isSafeInteger(value) || value < variable.min || value > variable.max) {
      problems.push(createDiagnostic({ code: diagnosticCodes.containerSettingsInvalid, severity: "error", message: `${variable.name} must be a whole number from ${variable.min} to ${variable.max}.`, details: { variable: variable.name } }));
      continue;
    }
    values[variable.field] = value;
  }
  const { HOST: host } = env;
  const hostname = host === undefined || host === "" ? "0.0.0.0" : host;
  if (!/^[\w.:[\]-]{1,253}$/.test(hostname))
    problems.push(createDiagnostic({ code: diagnosticCodes.containerSettingsInvalid, severity: "error", message: "HOST must be a host name or IP address.", details: { variable: "HOST" } }));
  if (problems.length > 0)
    throw new HolqaError(problems);
  return Object.freeze({ ...values as Omit<ContainerSettings, "hostname">, hostname });
}