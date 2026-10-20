import {
  mkdtempSync,
  rmSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { diagnosticsOf } from "@holqa/core";
import {
  createRuntime,
  silentSink
} from "@holqa/runtime-bun";

import {
  application,
  queue
} from "@test/support/descriptors";
import {
  describe,
  expect,
  it
} from "bun:test";

import { createDevBinding } from "@/local/dev-binding";

/** The fixture whose bindings module selects a provider that is never opened. */
const bound = join(import.meta.dir, "..", "fixtures", "apps", "bound");

describe("createDevBinding", () => {
  it("runs the default local platform on the state directory and exposes its state once started", async () => {
    const app = application("dev", [queue("orders")]);
    const dev = await createDevBinding(app, binding => createRuntime({ app, handlers: [], binding, log: silentSink, env: {} }), { stateDir: ":unused:", root: bound, signedUrlBase: "http://127.0.0.1:3000/_holqa/storage" });
    expect(dev.definition.name).toBe("local");
    expect(dev.binding.describe!(app["~holqa"].resources[0]!).binding).toBe("local");
    const directory = mkdtempSync(join(tmpdir(), "holqa-dev-binding-"));
    const real = await createDevBinding(app, binding => createRuntime({ app, handlers: [], binding, log: silentSink, env: {} }), { stateDir: directory, root: bound, signedUrlBase: "http://127.0.0.1:3000/_holqa/storage" });
    await real.runtime.start();
    try {
      expect(real.local().queues.messages("orders")).toEqual([]);
    } finally {
      await real.runtime.stop();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects a bindings module that binds another application", async () => {
    const app = application("dev", [queue("orders")]);
    let codes: string[] = [];
    try {
      await createDevBinding(app, binding => createRuntime({ app, handlers: [], binding, log: silentSink }), { stateDir: ":unused:", root: bound, signedUrlBase: "http://127.0.0.1:3000/_holqa/storage", bindingsModule: join(bound, "bindings.ts") });
    } catch (error) {
      codes = diagnosticsOf(error).map(diagnostic => diagnostic.code);
    }
    expect(codes).toEqual(["HOLQA_BINDING_CONFIG_INVALID"]);
  });

  it("uses a bindings module of the application and refuses local operations without local providers", async () => {
    const { default: app } = await import(join(bound, "infra.ts")) as { readonly default: ReturnType<typeof application> };
    const dev = await createDevBinding(app, binding => createRuntime({ app, handlers: [], binding, log: silentSink }), { stateDir: ":unused:", root: bound, signedUrlBase: "http://127.0.0.1:3000/_holqa/storage", bindingsModule: join(bound, "bindings.ts") });
    expect(dev.definition.name).toBe("staging");
    const local = dev.local();
    expect(local.storage.handles(new Request("http://localhost/_holqa/storage/x"))).toBe(false);
    let codes: string[] = [];
    try {
      local.queues.messages("orders");
    } catch (error) {
      codes = diagnosticsOf(error).map(diagnostic => diagnostic.code);
    }
    expect(codes).toEqual(["HOLQA_LOCAL_OPERATION_FAILED"]);
  });
});