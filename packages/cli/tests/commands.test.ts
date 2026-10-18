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
  it("matches single-word commands", () => {
    expect(findProposedCommand(["dev"])?.name).toBe("dev");
  });

  it("matches multi-word commands and ignores trailing arguments", () => {
    expect(findProposedCommand(["queue", "send", "orders"])?.name).toBe("queue send");
  });

  it("returns undefined for partial or unknown commands", () => {
    expect(findProposedCommand(["queue"])).toBeUndefined();
    expect(findProposedCommand(["deploy"])).toBeUndefined();
    expect(findProposedCommand([])).toBeUndefined();
  });

  it("has unique command names", () => {
    const names = proposedCommands.map(command => command.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("no longer lists implemented commands as proposed", () => {
    expect(implementedCommands.map(command => command.name)).toEqual(["inspect", "build --manifest"]);
    expect(findProposedCommand(["inspect"])).toBeUndefined();
    expect(findProposedCommand(["build"])).toBeUndefined();
  });
});