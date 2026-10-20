import type {
  AnyBindingProvider,
  PlannedChange,
  Provisioner,
  ProvisioningContext
} from "@holqa/core";

import {
  credentialRef,
  diagnosticsOf
} from "@holqa/core";
import {
  createApp,
  testPlatform,
  testQueueProvider
} from "@test/support/fixtures";

import {
  describe,
  expect,
  it
} from "bun:test";

import { defineBindings } from "@/define-bindings";
import {
  applyProvisioning,
  defineProvisioning,
  isProvisioningDefinition,
  planProvisioning
} from "@/provisioning";

/** Settings of a fake provisioner. */
interface FakeOptions {
  readonly name?: string;
  /** The providers it claims, by name. */
  readonly claims?: readonly string[];
  /** The actions it plans per claimed resource. */
  readonly action?: PlannedChange["action"];
  /** The target it plans, by resource. */
  readonly target?: (resource: string) => string;
  /** Fails applying the change of this target. */
  readonly failOn?: string;
  /** Records applied targets. */
  readonly applied?: string[];
  /** Runs while planning, with the context. */
  readonly onPlan?: (context: ProvisioningContext) => void;
}

/**
 * Creates a provisioner that plans one change per claimed resource.
 *
 * @param options - What it claims, plans and fails on.
 * @returns The provisioner.
 */
function fake(options: FakeOptions = {}): Provisioner {
  const name = options.name ?? "fake";
  return {
    provisioningProtocol: 1,
    provisioner: "example.fake",
    name,
    credentials: [credentialRef("ADMIN_TOKEN")],
    supports: (provider: AnyBindingProvider) => (options.claims ?? ["broker"]).includes(provider.name),
    plan: async (context) => {
      options.onPlan?.(context);
      const action = options.action ?? "create";
      return {
        changes: context.resources.map(({ resource }) => ({ provisioner: name, type: "example.queue", target: options.target?.(resource.id) ?? resource.id, resource: resource.id, action, destructive: action === "replace" || action === "delete", reason: "test" })),
        diagnostics: [],
        outputs: { count: context.resources.length }
      };
    },
    apply: async (_context, changes) => {
      const outcome = [];
      for (const change of changes) {
        if (change.target === options.failOn) {
          outcome.push({ change, status: "failed" as const, message: "refused" });
          break;
        }
        options.applied?.push(change.target);
        outcome.push({ change, status: "applied" as const });
      }
      return outcome;
    }
  };
}

const bindings = defineBindings(createApp(), { name: "staging", defaults: testPlatform(), kinds: { queue: testQueueProvider() } });
/**
 * Looks up credentials for the tests: only the administrative token is set.
 *
 * @param name - The credential's name.
 * @returns Its value, if set.
 */
const lookup = (name: string): string | undefined => name === "ADMIN_TOKEN" ? "secret-admin-token" : undefined;

describe("defineProvisioning", () => {
  it("accepts provisioners of this protocol with distinct names", () => {
    expect(isProvisioningDefinition(defineProvisioning(bindings, { provisioners: [fake()] }))).toBe(true);
  });

  it("rejects other protocol versions, duplicate names and missing provisioners", () => {
    let codes: string[] = [];
    try {
      defineProvisioning(bindings, { provisioners: [{ ...fake(), provisioningProtocol: 2 }, fake(), fake()] });
    } catch (error) {
      codes = diagnosticsOf(error).map(diagnostic => diagnostic.code);
    }
    expect(codes).toEqual(["HOLQA_PROVISIONING_CONFIG_INVALID", "HOLQA_PROVISIONING_CONFIG_INVALID", "HOLQA_PROVISIONING_CONFIG_INVALID"]);
    expect(() => defineProvisioning(bindings, { provisioners: [] })).toThrow("at least one provisioner");
  });
});

describe("planProvisioning", () => {
  it("collects every provisioner's changes and lists unprovisioned resources", async () => {
    let seen: readonly string[] = [];
    const plan = await planProvisioning(defineProvisioning(bindings, { provisioners: [fake({ onPlan: context => seen = context.resources.map(({ resource }) => resource.id) })] }), { handlers: [], lookup });
    expect(seen).toEqual(["audit", "orders"]);
    expect(plan.changes.map(change => change.target)).toEqual(["audit", "orders"]);
    expect(plan.unprovisioned).toEqual([{ resource: "api", provider: "platform" }, { resource: "files", provider: "platform" }, { resource: "nightly", provider: "platform" }]);
    expect(plan.outputs).toEqual({ fake: { count: 2 } });
    expect(plan.diagnostics).toEqual([]);
  });

  it("reports two provisioners managing one target", async () => {
    const plan = await planProvisioning(defineProvisioning(bindings, { provisioners: [fake({ name: "one" }), fake({ name: "two" })] }), { handlers: [], lookup });
    expect(plan.diagnostics.map(diagnostic => diagnostic.code)).toEqual(["HOLQA_PROVISIONING_CONFIG_INVALID", "HOLQA_PROVISIONING_CONFIG_INVALID"]);
  });

  it("gives a provisioner only the credentials it declares, and reports missing ones by name", async () => {
    const plan = await planProvisioning(defineProvisioning(bindings, { provisioners: [fake({ onPlan: context => context.credential(credentialRef("QUEUE_URL")) })] }), { handlers: [], lookup });
    expect(plan.diagnostics.map(diagnostic => diagnostic.code)).toEqual(["HOLQA_BINDING_CONFIG_INVALID"]);
    const missing = await planProvisioning(defineProvisioning(bindings, { provisioners: [fake({ onPlan: context => context.credential(credentialRef("ADMIN_TOKEN")) })] }), { handlers: [], lookup: () => undefined });
    expect(missing.diagnostics.map(diagnostic => [diagnostic.code, diagnostic.message.includes("secret")])).toEqual([["HOLQA_BINDING_CREDENTIALS_MISSING", false]]);
  });
});

describe("applyProvisioning", () => {
  it("applies non-destructive changes in order", async () => {
    const applied: string[] = [];
    const { result } = await applyProvisioning(defineProvisioning(bindings, { provisioners: [fake({ applied })] }), { handlers: [], lookup });
    expect(applied).toEqual(["audit", "orders"]);
    expect(result.diagnostics).toEqual([]);
  });

  it("applies nothing when a destructive change is not authorized", async () => {
    const applied: string[] = [];
    const definition = defineProvisioning(bindings, { provisioners: [fake({ applied, action: "replace" })] });
    const refused = await applyProvisioning(definition, { handlers: [], lookup });
    expect([applied, refused.result.diagnostics.map(diagnostic => diagnostic.code)]).toEqual([[], ["HOLQA_PROVISIONING_DESTRUCTIVE", "HOLQA_PROVISIONING_DESTRUCTIVE"]]);
    await applyProvisioning(definition, { handlers: [], lookup, allowDestructive: true });
    expect(applied).toEqual(["audit", "orders"]);
  });

  it("stops at the first failure and reports what was applied", async () => {
    const { result } = await applyProvisioning(defineProvisioning(bindings, { provisioners: [fake({ failOn: "audit" })] }), { handlers: [], lookup });
    expect(result.applied.map(item => [item.change.target, item.status])).toEqual([["audit", "failed"]]);
    expect(result.diagnostics.map(diagnostic => diagnostic.code)).toEqual(["HOLQA_PROVISIONING_FAILED"]);
  });
});