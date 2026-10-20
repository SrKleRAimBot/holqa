import {
  describe,
  expect,
  it
} from "bun:test";

import { combineHealth } from "@/binding/lifecycle";

describe("combineHealth", () => {
  it("is healthy without components", () => {
    expect(combineHealth([])).toEqual({ status: "healthy", components: [] });
  });

  it("reports the worst component status and keeps every report", () => {
    const components = [
      { name: "config", status: "healthy" as const },
      { name: "rabbitmq", status: "degraded" as const, message: "Reconnecting to the broker." },
      { name: "s3", status: "healthy" as const }
    ];
    expect(combineHealth(components)).toEqual({ status: "degraded", components });
    expect(combineHealth([...components, { name: "scheduler", status: "unhealthy" }]).status).toBe("unhealthy");
  });

  it("returns frozen data", () => {
    const health = combineHealth([{ name: "a", status: "healthy" }]);
    expect(Object.isFrozen(health)).toBe(true);
    expect(Object.isFrozen(health.components)).toBe(true);
  });
});