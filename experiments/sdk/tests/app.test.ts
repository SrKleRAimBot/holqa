import {
  bindApp,
  errorCode,
  getAppDescriptor
} from "@holqa/experiment-model";
import { createFakeBinding } from "@test/support/fake-binding";

import {
  describe,
  expect,
  it
} from "bun:test";

import { z } from "zod";
import {
  defineApp,
  queue,
  secret,
  variable
} from "@/index";

/**
 * Builds a small application from fresh resource handles.
 *
 * @returns The application.
 */
function buildApp() {
  return defineApp({
    name: "demo",
    handlers: ["./src/**/*.handler.ts"],
    resources: { jobs: queue({ id: "jobs", message: z.object({ n: z.number() }), schemaVersion: 1 }) },
    env: { TOKEN: secret(z.string()), MODE: variable(z.enum(["a", "b"]), { default: "a" }) }
  });
}

describe("defineApp", () => {
  it("produces equivalent plain descriptors when called twice", () => {
    const first = getAppDescriptor(buildApp());
    const second = getAppDescriptor(buildApp());
    expect(first?.name).toBe("demo");
    expect(first?.resources.map(resource => [resource.kind, resource.id, resource.config])).toEqual(second!.resources.map(resource => [resource.kind, resource.id, resource.config]));
    expect(first?.config.map(entry => [entry.name, entry.sensitive, entry.defaultValue])).toEqual([["TOKEN", true, undefined], ["MODE", false, "a"]]);
  });

  it("fails clearly when handles or configuration are used without a runtime", async () => {
    const app = buildApp();
    let code: unknown;
    try {
      void app.env.TOKEN;
    } catch (error) {
      code = errorCode(error);
    }
    expect(code).toBe("HOLQA_RUNTIME_NOT_BOUND");
    expect(await app.resources.jobs.send({ n: 1 }).then(() => undefined, (error: unknown) => errorCode(error))).toBe("HOLQA_RUNTIME_NOT_BOUND");
  });

  it("reads configuration and sends messages through the bound runtime", async () => {
    const app = buildApp();
    const binding = createFakeBinding({ TOKEN: "t", MODE: "b" });
    const unbind = bindApp(getAppDescriptor(app)!, binding);
    expect(app.env.MODE).toBe("b");
    await app.resources.jobs.send({ n: 2 });
    expect(binding.sent).toEqual([{ queue: "jobs", message: { n: 2 } }]);
    unbind();
    expect(() => app.env.MODE).toThrow();
  });

  it("rejects rebinding and resources shared between applications", () => {
    const app = buildApp();
    bindApp(getAppDescriptor(app)!, createFakeBinding());
    expect(() => bindApp(getAppDescriptor(app)!, createFakeBinding())).toThrow();

    const shared = queue({ id: "shared", message: z.string(), schemaVersion: 1 });
    defineApp({ name: "one", handlers: [], resources: { shared } });
    expect(() => defineApp({ name: "two", handlers: [], resources: { shared } })).toThrow();
  });

  it("rejects values that are not Standard Schemas at declaration time", () => {
    expect(() => queue({ id: "bad", schemaVersion: 1, message: { parse: () => 1 } as never })).toThrow();
  });
});