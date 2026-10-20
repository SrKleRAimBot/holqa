import type {
  Diagnostic,
  ResourceDescriptorOf,
  RuntimeBinding
} from "@/index";

import {
  appDescriptor,
  envelope,
  id,
  queueDescriptor,
  recordingBinding,
  scheduleDescriptor
} from "@test/support/descriptors";
import {
  describe,
  expect,
  it
} from "bun:test";

import {
  bindApp,
  readConfig,
  requireBinding,
  resolveDriver
} from "@/binding/bind";
import { diagnosticsOf } from "@/errors/holqa-error";

/**
 * Runs a function that must throw and returns the codes of the diagnostics it threw.
 *
 * @param run - The function expected to throw a Holqa error.
 * @returns The diagnostic codes.
 */
function codesOf(run: () => unknown): string[] {
  try {
    run();
  } catch (error) {
    return diagnosticsOf(error).map(diagnostic => diagnostic.code);
  }
  return [];
}

describe("bindApp", () => {
  it("installs a binding and resolves logical resources to its drivers", async () => {
    const orders = queueDescriptor("orders");
    const app = appDescriptor([orders]);
    const binding = recordingBinding();
    const unbind = bindApp(app, binding);
    expect(requireBinding(app, "test")).toBe(binding);
    await resolveDriver(app, orders, "queue \"orders\" send").send(envelope("hello"), {});
    expect(binding.sent).toEqual(["hello"]);
    expect(readConfig(app, app.config[0]!)).toBe("value of TOKEN");
    unbind();
    unbind();
    expect(app.binding.current).toBeUndefined();
  });

  it("resolves the same logical resource to whichever binding is installed", async () => {
    const orders = queueDescriptor("orders");
    const app = appDescriptor([orders]);
    const local = recordingBinding();
    const external = recordingBinding();
    const unbindLocal = bindApp(app, local);
    await resolveDriver(app, orders, "send").send(envelope(1), {});
    unbindLocal();
    bindApp(app, external);
    await resolveDriver(app, orders, "send").send(envelope(2), {});
    expect([local.sent, external.sent]).toEqual([[1], [2]]);
  });

  it("rejects rebinding instead of silently replacing the binding", () => {
    const app = appDescriptor([]);
    const first = recordingBinding();
    bindApp(app, first);
    expect(codesOf(() => bindApp(app, recordingBinding()))).toEqual(["HOLQA_RUNTIME_ALREADY_BOUND"]);
    expect(app.binding.current).toBe(first);
  });

  it("rejects a binding that cannot satisfy every declared requirement", () => {
    const app = appDescriptor([queueDescriptor("orders", { deadLetter: true, maxAttempts: 50 }), scheduleDescriptor("nightly")]);
    const binding = { ...recordingBinding(), capabilities: { queue: { delivery: ["at-least-once"] as const, maxAttempts: 10, deadLetter: false } } };
    expect(codesOf(() => bindApp(app, binding))).toEqual([
      "HOLQA_BINDING_CAPABILITY_UNSUPPORTED",
      "HOLQA_BINDING_CAPABILITY_UNSUPPORTED",
      "HOLQA_BINDING_CAPABILITY_UNSUPPORTED"
    ]);
    expect(app.binding.current).toBeUndefined();
  });

  it("rejects a binding without a driver for a declared kind that has operations", () => {
    const files: ResourceDescriptorOf<"bucket"> = { protocol: 1, type: "resource", kind: "bucket", id: id("files"), config: {}, requirements: { access: "private" }, schemas: {} };
    expect(codesOf(() => bindApp(appDescriptor([files]), recordingBinding()))).toEqual(["HOLQA_BINDING_CAPABILITY_UNSUPPORTED"]);
  });
});

describe("bindApp with a composed binding", () => {
  it("checks every resource against the provider selected for it and names that provider", () => {
    const orders = queueDescriptor("orders", { deadLetter: true });
    const audit = queueDescriptor("audit", { deadLetter: true });
    const binding: RuntimeBinding = {
      ...recordingBinding(),
      describe: resource => resource.id === "audit"
        ? { binding: "broker", capabilities: { queue: { delivery: ["at-least-once"], maxAttempts: 5, deadLetter: false } } }
        : { binding: "local", capabilities: { queue: { delivery: ["at-least-once"], maxAttempts: 5, deadLetter: true } } }
    };
    let diagnostics: readonly Diagnostic[] = [];
    try {
      bindApp(appDescriptor([orders, audit]), binding);
    } catch (error) {
      diagnostics = diagnosticsOf(error);
    }
    expect(diagnostics.map(diagnostic => [diagnostic.message, diagnostic.details])).toEqual([
      ["Binding \"broker\" cannot satisfy queue \"audit\": a dead-letter destination is required.", { resource: "audit", kind: "queue", binding: "broker", requirement: "queue.dead-letter" }]
    ]);
  });
});

describe("unbound use", () => {
  it("fails with HOLQA_RUNTIME_NOT_BOUND and a hint about top-level access", () => {
    const app = appDescriptor([queueDescriptor("orders")]);
    let message = "";
    try {
      requireBinding(app, "queue \"orders\" send");
    } catch (error) {
      message = diagnosticsOf(error).map(diagnostic => `${diagnostic.code} ${diagnostic.hint ?? ""}`).join();
    }
    expect(message).toContain("HOLQA_RUNTIME_NOT_BOUND");
    expect(message).toContain("never at module top level");
    expect(codesOf(() => readConfig(app, app.config[0]!))).toEqual(["HOLQA_RUNTIME_NOT_BOUND"]);
  });

  it("fails when a driver disappears after binding", () => {
    const orders = queueDescriptor("orders");
    const app = appDescriptor([]);
    bindApp(app, { ...recordingBinding(), drivers: {} });
    expect(codesOf(() => resolveDriver(app, orders, "send"))).toEqual(["HOLQA_BINDING_CAPABILITY_UNSUPPORTED"]);
  });
});