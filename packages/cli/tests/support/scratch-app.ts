import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync
} from "node:fs";
import {
  dirname,
  join
} from "node:path";

/** Where scratch applications are written: inside the package, so their imports resolve. */
const scratchRoot = join(import.meta.dir, "..", "..", ".tmp");

/** A scratch application on disk. */
export interface ScratchApp {
  readonly root: string;
  /** Writes (or replaces) a file of the application. */
  readonly write: (path: string, contents: string) => void;
  /** Removes the application and its local state. */
  readonly remove: () => void;
}

/**
 * Writes an application into a new scratch directory. Its modules import
 * fixture descriptors through `@test/support/descriptors`, which resolves
 * through this package's `tsconfig.json`.
 *
 * @param files - Files by path relative to the application root.
 * @returns The application.
 */
export function scratchApp(files: Readonly<Record<string, string>>): ScratchApp {
  mkdirSync(scratchRoot, { recursive: true });
  const root = mkdtempSync(join(scratchRoot, "app-"));
  /**
   * Writes one file.
   *
   * @param path - The path relative to the root.
   * @param contents - The file's complete contents.
   */
  const write = (path: string, contents: string): void => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), contents);
  };
  for (const [path, contents] of Object.entries(files))
    write(path, contents);
  return { root, write, remove: () => rmSync(root, { recursive: true, force: true }) };
}

/** The application module of the dev fixture: an API, a queue and a schedule. */
export const devInfra = `import { api, application, queue, schedule } from "@test/support/descriptors";
import { job } from "./src/contracts";

export default application("devapp", [api("api"), queue("jobs", job), schedule("nightly")]);
`;

/**
 * The contract module of the dev fixture.
 *
 * @param type - The JSON Schema type of the job message.
 * @returns The module source.
 */
export function devContracts(type: string): string {
  return `import { described } from "@test/support/descriptors";

export const job = described(${JSON.stringify(type)});
`;
}

/**
 * The handler module of the dev fixture.
 *
 * @param greeting - What \`GET /api/hello\` answers.
 * @returns The module source.
 */
export function devHandlers(greeting: string): string {
  return `import app from "../infra";
import { route, send, tick, worker } from "@test/support/descriptors";
import { job } from "./contracts";

export const hello = route("hello", "api", "GET", "/hello", () => new Response(${JSON.stringify(greeting)}));
export const enqueue = route("jobs.enqueue", "api", "POST", "/jobs", async () => Response.json({ messageId: await send(app, "jobs", "work") }));
export const run = worker("jobs.run", "jobs", (message, context) => context.log.info("job done", { message }), job);
export const nightly = tick("nightly.run", "nightly", () => {});
`;
}