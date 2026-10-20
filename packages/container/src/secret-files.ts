import type {
  BindingProvider,
  ProviderContext,
  ProviderInstance
} from "@holqa/core";

import {
  readdirSync,
  readFileSync,
  statSync
} from "node:fs";
import {
  join,
  resolve
} from "node:path";

import {
  bindingFailure,
  bindingProtocolVersion,
  HolqaError
} from "@holqa/core";

/** Settings of {@link secretFiles}. */
export interface SecretFilesOptions {
  /** The directory holding one file per value. Default `/run/secrets`, where container platforms conventionally mount secrets. */
  readonly directory?: string;
  /** The provider's name. Default `secret-files`. */
  readonly name?: string;
}

/** Matches the file names read as values: environment-variable-like names. Others, such as `..data` links, are ignored. */
const valueName = /^[A-Z_]\w*$/i;

/**
 * Creates a configuration service provider that reads values from files, one
 * file per value named like the value (for example `/run/secrets/API_TOKEN`),
 * as container platforms and orchestrators mount secrets. A trailing newline
 * is removed. `refresh` reads the directory again, so rotated secrets reach
 * credentials resolved afterwards (for example on reconnect). No hosted
 * secret manager is required.
 *
 * Select it alone or before the environment:
 * `services: { config: [container.secretFiles(), environmentConfig()] }`.
 *
 * @param options - Directory and name.
 * @returns A service provider for the `config` service.
 * @throws {HolqaError} `HOLQA_BINDING_CONFIG_INVALID` for an empty directory path.
 */
export function secretFiles(options: SecretFilesOptions = {}): BindingProvider<never, "config"> {
  const name = options.name ?? "secret-files";
  const directory = options.directory ?? "/run/secrets";
  if (typeof directory !== "string" || directory === "")
    throw new HolqaError(bindingFailure("configuration", { binding: name, message: "container.secretFiles: \"directory\" must be a directory path." }));
  /**
   * Reads every value file of the directory.
   *
   * @returns The values by name.
   * @throws {HolqaError} `HOLQA_BINDING_FAILED` when the directory cannot be read.
   */
  const read = (): Map<string, string> => {
    const path = resolve(directory);
    let entries: string[];
    try {
      entries = readdirSync(path);
    } catch (error) {
      throw new HolqaError(bindingFailure("failed", { binding: name, message: `The secrets directory ${directory} cannot be read: ${(error as { readonly code?: string }).code ?? "error"}.`, hint: "Mount the secrets at this path, or set \"directory\"." }));
    }
    const values = new Map<string, string>();
    for (const entry of entries) {
      const file = join(path, entry);
      if (valueName.test(entry) && statSync(file, { throwIfNoEntry: false })?.isFile() === true)
        values.set(entry, readFileSync(file, "utf8").replace(/\r?\n$/, ""));
    }
    return values;
  };
  return Object.freeze({
    bindingProtocol: bindingProtocolVersion,
    provider: "holqa.secret-files",
    name,
    role: "service",
    contracts: Object.freeze({ config: 1 }),
    resources: Object.freeze({}),
    services: Object.freeze({ config: true }),
    topology: Object.freeze({ delivery: "none", state: "host" }),
    settings: Object.freeze({ configSource: "files", directory }),
    /**
     * Reads the directory once; values are looked up from memory.
     *
     * @param _context - Unused: the files are the credentials.
     * @returns The instance with the configuration source.
     */
    open: async (_context: ProviderContext): Promise<ProviderInstance> => {
      let values = read();
      return Object.freeze({
        config: Object.freeze({
          lookup: (key: string) => values.get(key),
          refresh: async () => {
            values = read();
          }
        })
      });
    }
  });
}