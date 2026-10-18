import {
  describe,
  expect,
  it
} from "bun:test";

import { formatInspection } from "@/output/inspection";
import { compiledOutcome } from "@test/support/fake-host";

describe("formatInspection", () => {
  it("summarizes resources, handlers, configuration and capabilities", async () => {
    const outcome = await compiledOutcome();
    if (!outcome.ok)
      throw new Error("Expected the fixture to compile.");
    const { message } = outcome.manifest.resources[0]!.schemas;
    const fingerprint = message!.fingerprint.slice(0, 19);
    expect(formatInspection(outcome.manifest, outcome.entrypoints)).toBe([
      "Application \"basic\"",
      "  manifest version 1, runtime bun",
      "",
      "Resources (1)",
      `  queue  orders  at-least-once  message v1 ${fingerprint}`,
      "",
      "Handlers (1)",
      `  orders.process  queue.message <- queue "orders"  message ${fingerprint}  src/orders.handler.ts#default`,
      "",
      "Configuration (1)",
      "  secret  API_TOKEN",
      "",
      "Required capabilities (3)",
      "  queue",
      "  queue.delivery.at-least-once",
      "  trigger.queue.message"
    ].join("\n"));
  });
});
