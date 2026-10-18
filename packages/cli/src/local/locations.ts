import {
  basename,
  dirname,
  join,
  resolve
} from "node:path";

import { defaultAppModule } from "@/commands/analysis-command";

/** Where an application and its local files are. */
export interface AppLocation {
  /** The application module, absolute. */
  readonly appPath: string;
  /** The application root: the module's directory. */
  readonly root: string;
  /** The application module relative to the root. */
  readonly appModule: string;
  /** The local state directory. */
  readonly stateDir: string;
  /** Where `holqa dev` and the operation commands write the build they run. */
  readonly buildDir: string;
  /** The dev session file. */
  readonly sessionPath: string;
}

/** The local state directory, relative to the application root, when `--state-dir` is not given. */
export const defaultStateDir = ".holqa/local";

/**
 * Resolves the application and its local directories from the command line.
 *
 * @param cwd - The working directory.
 * @param app - The `--app` value, if any; default `infra.ts`.
 * @param stateDir - The `--state-dir` value, if any; relative to the working directory.
 * @returns The locations.
 */
export function locateApp(cwd: string, app: string | undefined, stateDir: string | undefined): AppLocation {
  const appPath = resolve(cwd, app ?? defaultAppModule);
  const root = dirname(appPath);
  return {
    appPath,
    root,
    appModule: basename(appPath),
    stateDir: stateDir === undefined ? join(root, defaultStateDir) : resolve(cwd, stateDir),
    buildDir: join(root, ".holqa", "dev", "build"),
    sessionPath: join(root, ".holqa", "dev", "session.json")
  };
}