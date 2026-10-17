import {
  describe,
  expect,
  it
} from "bun:test";

import {
  findProposedCommand,
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
});