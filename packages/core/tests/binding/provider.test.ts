import type {
  AnyBindingProvider,
  BindingProvider
} from "@/index";

import {
  platformProvider,
  queueProvider
} from "@test/support/providers";
import {
  describe,
  expect,
  expectTypeOf,
  it
} from "bun:test";

import {
  credentialRef,
  isBindingProvider,
  isCredentialReference,
  isProviderId
} from "@/binding/provider";
import { diagnosticsOf } from "@/errors/holqa-error";

describe("isBindingProvider", () => {
  it("recognizes providers by shape, including ones built by another copy of the package", () => {
    expect(isBindingProvider(queueProvider())).toBe(true);
    expect(isBindingProvider({ ...queueProvider() })).toBe(true);
  });

  it("rejects other values and other protocol versions", () => {
    expect(isBindingProvider(undefined)).toBe(false);
    expect(isBindingProvider({ ...queueProvider(), bindingProtocol: 2 })).toBe(false);
    expect(isBindingProvider({ ...queueProvider(), open: undefined })).toBe(false);
  });
});

describe("isProviderId", () => {
  it.each(["holqa.local", "example.edge-queue", "acme.queues.v2"])("accepts %p", (value) => {
    expect(isProviderId(value)).toBe(true);
  });

  it.each(["local", "Holqa.Local", "holqa..local", ".holqa", "holqa.", 42])("rejects %p", (value) => {
    expect(isProviderId(value)).toBe(false);
  });
});

describe("credentialRef", () => {
  it("creates a frozen reference that holds only the name", () => {
    const reference = credentialRef("QUEUE_URL");
    expect(reference).toEqual({ type: "credential", name: "QUEUE_URL" });
    expect(Object.isFrozen(reference)).toBe(true);
    expect(isCredentialReference(reference)).toBe(true);
  });

  it("rejects names that cannot be environment variables", () => {
    let codes: string[] = [];
    try {
      credentialRef("1-URL");
    } catch (error) {
      codes = diagnosticsOf(error).map(diagnostic => diagnostic.code);
    }
    expect(codes).toEqual(["HOLQA_BINDING_CONFIG_INVALID"]);
    expect(isCredentialReference({ type: "credential", name: "has space" })).toBe(false);
    expect(isCredentialReference("QUEUE_URL")).toBe(false);
  });
});

describe("BindingProvider types", () => {
  it("records the kinds and services a provider binds", () => {
    expectTypeOf(queueProvider()).toExtend<BindingProvider<"queue">>();
    expectTypeOf(queueProvider()).toExtend<AnyBindingProvider>();
    expectTypeOf(platformProvider()).toExtend<BindingProvider<"bucket", "telemetry">>();
  });

  it("rejects a provider for a kind it does not bind", () => {
    // @ts-expect-error A queue provider cannot be used where a bucket provider is required.
    const bucket: BindingProvider<"bucket"> = queueProvider();
    // @ts-expect-error A queue provider does not supply the configuration service.
    const config: BindingProvider<never, "config"> = queueProvider();
    expect([bucket, config]).toHaveLength(2);
  });
});