import {
  describe,
  expect,
  it
} from "bun:test";

import {
  findProposedCommand,
  implementedCommands,
  proposedCommands
} from "@/commands";

describe("findProposedCommand", () => {
  it("matches multi-word commands and ignores trailing arguments", () => {
    expect(findProposedCommand(["openapi", "generate", "api"])?.name).toBe("openapi generate");
  });

  it("returns undefined for partial or unknown commands", () => {
    expect(findProposedCommand(["openapi"])).toBeUndefined();
    expect(findProposedCommand(["deploy"])).toBeUndefined();
    expect(findProposedCommand([])).toBeUndefined();
  });

  it("has unique command names", () => {
    const names = proposedCommands.map(command => command.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("no longer lists implemented commands as proposed", () => {
    expect(implementedCommands.map(command => command.name)).toEqual(["inspect", "bindings inspect", "bindings validate", "build --manifest", "package", "dev", "invoke", "queue send", "queue redrive", "storage put", "cron run", "state", "doctor", "logs", "traces list", "traces inspect", "events inspect", "metrics"]);
    for (const words of [["inspect"], ["build"], ["package"], ["dev"], ["invoke"], ["queue", "send"], ["queue", "redrive"], ["storage", "put"], ["cron", "run"], ["doctor"], ["logs"], ["traces", "list"], ["traces", "inspect"], ["events", "inspect"], ["metrics"]])
      expect(findProposedCommand(words)).toBeUndefined();
  });
});