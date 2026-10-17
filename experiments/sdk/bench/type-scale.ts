/**
 * Measures how type-checking cost grows with application size. Generates an
 * application with N queues, N routes and N consumers in separate handler
 * modules (importing the built SDK by package name, like a real consumer), then
 * runs `tsc --extendedDiagnostics` and prints the check time and type counts.
 *
 * Usage: bun bench/type-scale.ts 10 50 200
 */
import {
  mkdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { join } from "node:path";

/** Directory that holds generated projects; gitignored. */
const scratch = join(import.meta.dir, "..", ".tmp", "type-scale");

/**
 * Writes a generated application with `size` queues, routes and consumers.
 *
 * @param size - How many of each resource and handler to generate.
 * @returns The directory of the generated project.
 */
function generate(size: number): string {
  const root = join(scratch, `n${size}`);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(join(root, "handlers"), { recursive: true });
  const queues = Array.from({ length: size }, (_, index) => `    q${index}: queue({ id: "queue-${index}", schemaVersion: 1, message: z.object({ id: z.string(), count: z.number().int(), kind: z.enum(["a", "b", "c"]), at: z.iso.datetime().transform(value => new Date(value)), tags: z.array(z.string()).default([]) }) })`);
  writeFileSync(join(root, "infra.ts"), `import { defineApp, http, queue } from "@holqa/experiment-sdk";
import { z } from "zod";

const app = defineApp({
  name: "scale",
  handlers: ["./handlers/*.ts"],
  resources: {
    api: http.api({ id: "api", basePath: "/api" }),
${queues.join(",\n")}
  }
});

export const resources = app.resources;
`);
  for (let index = 0; index < size; index++) {
    writeFileSync(join(root, "handlers", `h${index}.ts`), `import { z } from "zod";
import { resources } from "../infra";

export const route${index} = resources.api.route({
  id: "route-${index}",
  method: "POST",
  path: "/items/:itemId/r${index}",
  body: z.object({ count: z.number(), kind: z.enum(["a", "b", "c"]) }),
  responses: { 202: z.object({ id: z.string() }), 404: z.object({ message: z.string() }) },
  handler: async ({ params, body, reply }) => {
    await resources.q${index}.send({ id: params.itemId, count: body.count, kind: body.kind, at: "2026-10-17T00:00:00Z" });
    return reply(202, { id: params.itemId });
  }
});

export const consumer${index} = resources.q${index}.consume({
  id: "consume-${index}",
  handler: ({ message }) => { message.at.getTime(); }
});
`);
  }
  writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ extends: "../../../../../tsconfig.base.json", compilerOptions: { types: [], noEmit: true }, include: ["**/*.ts"] }));
  return root;
}

for (const size of process.argv.slice(2).map(Number)) {
  const root = generate(size);
  const result = Bun.spawnSync(["bunx", "tsc", "-p", join(root, "tsconfig.json"), "--extendedDiagnostics"], { cwd: join(import.meta.dir, "..") });
  const output = result.stdout.toString();
  /**
   * Reads one metric from the extended diagnostics output.
   *
   * @param label - The metric label, for example `Check time`.
   * @returns The metric value, or `?` when it is missing.
   */
  const pick = (label: string): string => output.match(new RegExp(`${label}:\\s+(\\S+)`))?.[1] ?? "?";
  const errors = output.split("\n").filter(line => line.includes("error TS")).length;
  process.stdout.write(`n=${size} errors=${errors} check=${pick("Check time")} total=${pick("Total time")} types=${pick("Types")} instantiations=${pick("Instantiations")} memory=${pick("Memory used")}\n`);
  if (errors > 0)
    process.stdout.write(`${output.split("\n").filter(line => line.includes("error TS")).slice(0, 3).join("\n")}\n`);
}