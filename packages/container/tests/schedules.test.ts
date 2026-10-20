import { validateProvider } from "@holqa/core";

import {
  describe,
  expect,
  it
} from "bun:test";

import { schedules } from "@/schedules";

describe("container.schedules", () => {
  it("is a process-local schedule provider with the local scheduler's overlap policies", () => {
    const provider = schedules();
    expect(validateProvider(provider)).toEqual([]);
    expect([provider.provider, provider.name, provider.contracts]).toEqual(["holqa.container", "container.schedules", { schedule: 1 }]);
    expect(provider.topology).toEqual({ delivery: "pull", state: "process" });
    expect(provider.resources.schedule).toEqual({ overlap: ["skip", "allow"] });
  });
});