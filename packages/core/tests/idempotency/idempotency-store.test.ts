import {
  describe,
  expect,
  it
} from "bun:test";

import {
  createIdempotencyKey,
  createMemoryIdempotencyStore
} from "@/idempotency/idempotency-store";

/**
 * Creates a memory store on a controllable clock with sequential tokens.
 *
 * @returns The store and a function that moves its clock forward.
 */
function storeOnClock(): { readonly store: ReturnType<typeof createMemoryIdempotencyStore>; readonly advance: (ms: number) => void } {
  let now = 1_000;
  let tokens = 0;
  return {
    store: createMemoryIdempotencyStore({ now: () => now, createToken: () => `t-${++tokens}` }),
    advance: (ms) => {
      now += ms;
    }
  };
}

describe("createIdempotencyKey", () => {
  it("encodes parts so that separators inside parts never collide", () => {
    expect(createIdempotencyKey(["a:b", "c"])).toBe("a%3Ab:c");
    expect(createIdempotencyKey(["a", "b:c"])).toBe("a:b%3Ac");
    expect(createIdempotencyKey(["order", 42])).toBe("order:42");
  });

  it.each([[[]], [[""]], [[1.5]], [[Number.NaN]]])("rejects %p", (parts) => {
    expect(() => createIdempotencyKey(parts as never)).toThrow(RangeError);
  });
});

describe("createMemoryIdempotencyStore", () => {
  it("lets the first claimant process a key and reports it completed afterwards", async () => {
    const { store } = storeOnClock();
    const claim = await store.begin("h", "k", { leaseMs: 100 });
    expect(claim).toEqual({ status: "acquired", token: "t-1" });
    expect(await store.begin("h", "k", { leaseMs: 100 })).toEqual({ status: "in-progress", expiresAt: new Date(1_100).toISOString() });
    expect(await store.complete("h", "k", "t-1", { retentionMs: 500 })).toBe(true);
    expect(await store.begin("h", "k", { leaseMs: 100 })).toEqual({ status: "completed", completedAt: new Date(1_000).toISOString() });
  });

  it("keeps scopes apart", async () => {
    const { store } = storeOnClock();
    await store.begin("a", "k", { leaseMs: 100 });
    expect((await store.begin("b", "k", { leaseMs: 100 })).status).toBe("acquired");
  });

  it("frees a released key for the next delivery", async () => {
    const { store } = storeOnClock();
    await store.begin("h", "k", { leaseMs: 100 });
    expect(await store.release("h", "k", "t-1")).toBe(true);
    expect(await store.begin("h", "k", { leaseMs: 100 })).toEqual({ status: "acquired", token: "t-2" });
  });

  it("lets a claim expire, after which the old holder can no longer complete it", async () => {
    const { store, advance } = storeOnClock();
    await store.begin("h", "k", { leaseMs: 100 });
    advance(100);
    expect(await store.begin("h", "k", { leaseMs: 100 })).toEqual({ status: "acquired", token: "t-2" });
    expect(await store.complete("h", "k", "t-1", { retentionMs: 500 })).toBe(false);
    expect(await store.release("h", "k", "t-1")).toBe(false);
  });

  it("renews a held claim, and refuses to renew one it lost", async () => {
    const { store, advance } = storeOnClock();
    await store.begin("h", "k", { leaseMs: 100 });
    advance(90);
    expect(await store.extend("h", "k", "t-1", { leaseMs: 100 })).toBe(true);
    advance(90);
    expect((await store.begin("h", "k", { leaseMs: 100 })).status).toBe("in-progress");
    advance(10);
    expect(await store.extend("h", "k", "t-1", { leaseMs: 100 })).toBe(false);
    expect(await store.extend("h", "k", "wrong", { leaseMs: 100 })).toBe(false);
  });

  it("forgets completed keys after their retention, so later duplicates are processed again", async () => {
    const { store, advance } = storeOnClock();
    await store.begin("h", "k", { leaseMs: 100 });
    await store.complete("h", "k", "t-1", { retentionMs: 500 });
    advance(499);
    expect((await store.begin("h", "k", { leaseMs: 100 })).status).toBe("completed");
    advance(1);
    expect((await store.begin("h", "k", { leaseMs: 100 })).status).toBe("acquired");
  });
});