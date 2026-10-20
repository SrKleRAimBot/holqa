import type {
  AnyBindingProvider,
  AppDescriptor,
  ProviderContext,
  ProviderInstance,
  ResourceDescriptorOf
} from "@holqa/core";

import type { LocalPersistence } from "@/providers";

import {
  bucketConformance,
  bucketEventsConformance,
  queueConformance,
  registerConformance,
  scheduleConformance
} from "@holqa/conformance";
import {
  credentialRef,
  diagnosticsOf,
  getAppDescriptor,
  validateProvider
} from "@holqa/core";
import {
  application,
  bucketResource,
  queueResource,
  scheduleResource,
  stateDirectory
} from "@test/support/fixtures";

import {
  afterAll,
  describe,
  expect,
  it
} from "bun:test";

import { ManualClock } from "@/clock";
import {
  local,
  localEnvironment,
  localStateOf
} from "@/providers";

/** A state directory shared by the SQLite-mode tests, removed at the end. */
const directories: Array<{ readonly remove: () => void }> = [];

afterAll(() => {
  for (const directory of directories)
    directory.remove();
});

/**
 * Builds the context a provider is opened with.
 *
 * @param app - The application descriptor.
 * @returns A context whose credentials resolve to placeholder values.
 */
function contextOf(app: AppDescriptor): ProviderContext {
  return {
    app,
    environment: "test",
    resources: app.resources,
    credential: reference => `value of ${reference.name}`,
    signal: new AbortController().signal,
    log: () => {}
  };
}

/** The resources every conformance case uses. */
const resources = [queueResource("jobs", { deadLetter: true }), bucketResource("files"), scheduleResource("ticker", "* * * * *")];

/**
 * Opens a fresh local platform with a manual clock.
 *
 * @param persistence - Where state is kept.
 * @returns The opened instance, its clock, the descriptors and a closer.
 */
async function openPlatform(persistence: LocalPersistence): Promise<{ readonly instance: ProviderInstance; readonly clock: ManualClock; readonly app: AppDescriptor; readonly close: () => Promise<void> }> {
  const clock = new ManualClock();
  const directory = persistence === "sqlite" ? stateDirectory() : undefined;
  if (directory !== undefined)
    directories.push(directory);
  const app = getAppDescriptor(application(resources))!;
  const platform = local.platform({ persistence, ...directory === undefined ? {} : { directory: directory.path }, clock, env: {}, telemetry: false });
  const instance = await platform.open(contextOf(app));
  return { instance, clock, app, close: async () => instance.stop?.({ signal: new AbortController().signal }) };
}

/**
 * Finds a resource of the test application.
 *
 * @param app - The application.
 * @param id - The identifier.
 * @returns The descriptor.
 */
function resourceOf<Kind extends "queue" | "bucket" | "schedule">(app: AppDescriptor, id: string): ResourceDescriptorOf<Kind> {
  return app.resources.find(resource => resource.id === id) as ResourceDescriptorOf<Kind>;
}

for (const persistence of ["memory", "sqlite"] as const) {
  describe(`local platform (${persistence})`, () => {
    let clock = new ManualClock();
    const time = {
      advance: async (ms: number) => {
        clock.advance(ms);
        await Bun.sleep(2);
      },
      now: () => clock.now()
    };
    registerConformance(queueConformance, {
      time,
      open: async () => {
        const opened = await openPlatform(persistence);
        clock = opened.clock;
        const queue = resourceOf<"queue">(opened.app, "jobs");
        return { driver: opened.instance.drivers!.queue!(queue), source: opened.instance.sources!.queue!(queue), capabilities: local.platform().resources.queue, close: opened.close };
      }
    }, { describe, it });
    registerConformance(bucketConformance, {
      time,
      open: async () => {
        const opened = await openPlatform(persistence);
        clock = opened.clock;
        const bucket = resourceOf<"bucket">(opened.app, "files");
        return { driver: opened.instance.drivers!.bucket!(bucket), events: opened.instance.sources!.bucket!(bucket), capabilities: local.platform().resources.bucket, bucketId: "files", close: opened.close };
      }
    }, { describe, it });
    registerConformance(bucketEventsConformance, {
      time,
      open: async () => {
        const opened = await openPlatform(persistence);
        clock = opened.clock;
        const bucket = resourceOf<"bucket">(opened.app, "files");
        return { driver: opened.instance.drivers!.bucket!(bucket), events: opened.instance.sources!.bucket!(bucket), capabilities: local.platform().resources.bucket, bucketId: "files", close: opened.close };
      }
    }, { describe, it });
    registerConformance(scheduleConformance, {
      time,
      open: async () => {
        const opened = await openPlatform(persistence);
        clock = opened.clock;
        return { source: opened.instance.sources!.schedule!(resourceOf<"schedule">(opened.app, "ticker")), close: opened.close };
      }
    }, { describe, it });
  });
}

describe("local providers", () => {
  it("are valid providers with honest roles, contracts and topology", () => {
    const env = localEnvironment({ persistence: "memory" });
    for (const provider of [env.platform(), env.queues(), env.buckets(), env.schedules()] as AnyBindingProvider[])
      expect(validateProvider(provider)).toEqual([]);
    expect(env.platform().name).toBe("local");
    expect(env.queues().name).toBe("local.queues");
    expect(env.platform().topology).toEqual({ delivery: "pull", state: "process" });
    expect(local.platform().topology).toEqual({ delivery: "pull", state: "host" });
    expect(local.platform().settings).toEqual({ persistence: "sqlite", directory: ".holqa/local", configSource: "environment" });
    expect(local.platform({ persistence: "memory", env: {} }).settings).toEqual({ persistence: "memory", configSource: "values" });
  });

  it("opens nothing until a provider is opened, and validates settings when created", () => {
    let codes: string[] = [];
    try {
      localEnvironment({ persistence: "disk" as never, queues: { pollIntervalMs: 0 }, storage: { signedUrlBase: "ftp://x" } });
    } catch (error) {
      codes = diagnosticsOf(error).map(diagnostic => diagnostic.code);
    }
    expect(codes).toEqual(["HOLQA_BINDING_CONFIG_INVALID", "HOLQA_BINDING_CONFIG_INVALID", "HOLQA_BINDING_CONFIG_INVALID"]);
    expect(localEnvironment({ persistence: "memory" }).state()).toBeUndefined();
  });

  it("share one state between the platform and per-kind providers, and close it with the last one", async () => {
    const env = localEnvironment({ persistence: "memory", env: { API_TOKEN: "token" } });
    const app = getAppDescriptor(application(resources))!;
    const platform = await env.platform().open(contextOf(app));
    const queues = await env.queues().open(contextOf(app));
    const jobs = resourceOf<"queue">(app, "jobs");
    const { messageId } = await queues.drivers!.queue!(jobs).send({ format: "holqa.message/1", schemaVersion: 1, payload: "shared" }, {});
    expect(env.state()!.queues.messages("jobs").map(message => message.messageId)).toEqual([messageId]);
    expect(platform.config!.lookup("API_TOKEN")).toBe("token");
    await platform.stop!({ signal: new AbortController().signal });
    expect(env.state()).toBeDefined();
    await queues.stop!({ signal: new AbortController().signal });
    await queues.stop!({ signal: new AbortController().signal });
    expect(env.state()).toBeUndefined();
  });

  it("refuses to share one state between two applications", async () => {
    const env = localEnvironment({ persistence: "memory" });
    const first = getAppDescriptor(application(resources))!;
    const second = { ...first };
    await env.platform().open(contextOf(first));
    let codes: string[] = [];
    try {
      await env.queues().open(contextOf(second));
    } catch (error) {
      codes = diagnosticsOf(error).map(diagnostic => diagnostic.code);
    }
    expect(codes).toEqual(["HOLQA_BINDING_CONFIG_INVALID"]);
  });

  it("keeps sqlite state across restarts and loses memory state", async () => {
    const directory = stateDirectory();
    directories.push(directory);
    const app = getAppDescriptor(application(resources))!;
    const jobs = resourceOf<"queue">(app, "jobs");
    for (const [persistence, expected] of [["sqlite", 1], ["memory", 0]] as const) {
      const options = { persistence, directory: directory.path, env: {}, telemetry: false };
      const first = await local.queues(options).open(contextOf(app));
      await first.drivers!.queue!(jobs).send({ format: "holqa.message/1", schemaVersion: 1, payload: "kept?" }, {});
      await first.stop!({ signal: new AbortController().signal });
      const env = localEnvironment(options);
      const second = await env.queues().open(contextOf(app));
      expect(env.state()!.queues.messages("jobs").length).toBe(expected);
      await second.stop!({ signal: new AbortController().signal });
    }
  });

  it("supplies telemetry from the local telemetry store when asked to", async () => {
    const app = getAppDescriptor(application(resources))!;
    const env = localEnvironment({ persistence: "memory", env: {} });
    const instance = await env.platform().open(contextOf(app));
    expect(instance.telemetry?.map(exporter => exporter.name)).toEqual([env.state()!.telemetry!.exporter.name]);
    await instance.stop!({ signal: new AbortController().signal });
    expect(credentialRef("X").name).toBe("X");
  });

  it("expose their opened state through localStateOf, and nothing for other values, other environments or closed state", async () => {
    const env = localEnvironment({ persistence: "memory" });
    const other = localEnvironment({ persistence: "memory" });
    const app = getAppDescriptor(application(resources))!;
    const platform = env.platform();
    const queues = env.queues();
    expect(localStateOf(platform)).toBeUndefined();
    const instance = await platform.open(contextOf(app));
    expect(localStateOf(platform)).toBe(env.state()!);
    expect(localStateOf(queues)).toBe(env.state()!);
    expect(localStateOf(other.platform())).toBeUndefined();
    for (const value of [undefined, null, "local", 42, {}, { ...platform }])
      expect(localStateOf(value)).toBeUndefined();
    await instance.stop!({ signal: new AbortController().signal });
    expect(localStateOf(platform)).toBeUndefined();
  });
});