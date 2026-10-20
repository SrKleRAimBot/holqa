import type { LocalEnvironment } from "@/environment";

import {
  application,
  queueResource,
  sequentialIds,
  stateDirectory
} from "@test/support/fixtures";
import {
  afterEach,
  describe,
  expect,
  it
} from "bun:test";

import { ManualClock } from "@/clock";
import { createLocalEnvironment } from "@/environment";

/** Cleanups to run after each test. */
const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse())
    cleanup();
});

/**
 * Opens environments that share one state directory, as `holqa dev` and a CLI operation process do.
 *
 * @param count - How many environments to open.
 * @returns The environments and their shared clock.
 */
async function shared(count: number): Promise<{ readonly envs: LocalEnvironment[]; readonly clock: ManualClock }> {
  const directory = stateDirectory();
  cleanups.push(directory.remove);
  const clock = new ManualClock(Date.parse("2026-10-18T10:00:00.000Z"));
  const envs: LocalEnvironment[] = [];
  for (let index = 0; index < count; index++) {
    const env = await createLocalEnvironment({ app: application([queueResource("jobs")]), directory: directory.path, clock, createId: sequentialIds(`e${index}-`), env: {} });
    cleanups.push(() => env.close());
    envs.push(env);
  }
  return { envs, clock };
}

describe("local operation budgets", () => {
  it("spends one count per root operation across environments that share a directory", async () => {
    const { envs: [first, second] } = await shared(2);
    const budgets = [first!.binding.operationBudgets!, second!.binding.operationBudgets!];
    const results = await Promise.all(Array.from({ length: 10 }, async (_, index) => budgets[index % 2]!.consume({ operationId: "root-1", amount: 1, limit: 4 })));
    expect(results.filter(result => result.allowed)).toHaveLength(4);
    expect(await budgets[1]!.consume({ operationId: "root-1", amount: 1, limit: 4 })).toEqual({ allowed: false, used: 4 });
    expect(await budgets[0]!.consume({ operationId: "root-2", amount: 3, limit: 4 })).toEqual({ allowed: true, used: 3 });
    expect(await budgets[0]!.consume({ operationId: "root-2", amount: 2, limit: 4 })).toEqual({ allowed: false, used: 3 });
  });
});

describe("local idempotency store", () => {
  it("claims, completes and expires keys durably and shares them between environments", async () => {
    const { envs: [first, second], clock } = await shared(2);
    const a = first!.binding.idempotency!;
    const b = second!.binding.idempotency!;
    const claim = await a.begin("orders.process", "m-1", { leaseMs: 1_000 });
    expect(claim.status).toBe("acquired");
    expect(await b.begin("orders.process", "m-1", { leaseMs: 1_000 })).toEqual({ status: "in-progress", expiresAt: "2026-10-18T10:00:01.000Z" });
    expect(await b.begin("other.handler", "m-1", { leaseMs: 1_000 })).toMatchObject({ status: "acquired" });
    expect(await a.complete("orders.process", "m-1", claim.status === "acquired" ? claim.token : "", { retentionMs: 60_000 })).toBe(true);
    expect(await b.begin("orders.process", "m-1", { leaseMs: 1_000 })).toEqual({ status: "completed", completedAt: "2026-10-18T10:00:00.000Z" });
    clock.advance(60_000);
    expect((await b.begin("orders.process", "m-1", { leaseMs: 1_000 })).status).toBe("acquired");
  });

  it("lets a crashed holder's claim expire, and refuses its late completion", async () => {
    const { envs: [env], clock } = await shared(1);
    const store = env!.binding.idempotency!;
    const stale = await store.begin("h", "k", { leaseMs: 100 });
    clock.advance(100);
    const fresh = await store.begin("h", "k", { leaseMs: 100 });
    expect(fresh.status).toBe("acquired");
    expect(await store.complete("h", "k", stale.status === "acquired" ? stale.token : "", { retentionMs: 1_000 })).toBe(false);
    clock.advance(90);
    expect(await store.extend("h", "k", fresh.status === "acquired" ? fresh.token : "", { leaseMs: 100 })).toBe(true);
    clock.advance(90);
    expect((await store.begin("h", "k", { leaseMs: 100 })).status).toBe("in-progress");
    expect(await store.extend("h", "k", stale.status === "acquired" ? stale.token : "", { leaseMs: 100 })).toBe(false);
    expect(await store.release("h", "k", fresh.status === "acquired" ? fresh.token : "")).toBe(true);
    expect((await store.begin("h", "k", { leaseMs: 100 })).status).toBe("acquired");
  });
});