import type { Provisioner } from "@holqa/core";

import {
  existsSync,
  readFileSync,
  writeFileSync
} from "node:fs";

import { defineProvisioning } from "@holqa/bindings";
import { credentialRef } from "@holqa/core";

import bindings from "@test/fixtures/apps/bound/bindings";

/** Where the fake infrastructure is kept between the plan and apply processes: queue names and their kind. */
const { FIXTURE_STATE_FILE: file = "" } = process.env;

/**
 * Reads the fake infrastructure.
 *
 * @returns Existing queue names, mapped to `ok` or `conflict`.
 */
function state(): Record<string, string> {
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) as Record<string, string> : {};
}

/** Creates one queue per bound queue in a JSON file; `conflict` entries need replacing. */
const provisioner: Provisioner = {
  provisioningProtocol: 1,
  provisioner: "example.file-queues",
  name: "file-queues",
  credentials: [credentialRef("FIXTURE_ADMIN_TOKEN")],
  supports: provider => provider.name === "broker",
  plan: async (context) => {
    context.credential(credentialRef("FIXTURE_ADMIN_TOKEN"));
    const existing = state();
    return {
      changes: context.resources.map(({ resource }) => {
        const found = existing[resource.id];
        const action = found === undefined ? "create" as const : found === "conflict" ? "replace" as const : "none" as const;
        return { provisioner: "file-queues", type: "example.queue", target: resource.id, resource: resource.id, action, destructive: action === "replace", reason: action === "create" ? "It does not exist." : action === "replace" ? "It exists with other settings." : "It exists." };
      }),
      diagnostics: []
    };
  },
  apply: async (_context, changes) => {
    const existing = state();
    for (const change of changes)
      existing[change.target] = "ok";
    writeFileSync(file, JSON.stringify(existing));
    return changes.map(change => ({ change, status: "applied" as const }));
  }
};

export default defineProvisioning(bindings, { provisioners: [provisioner] });