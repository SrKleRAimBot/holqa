import type { Database } from "bun:sqlite";

import {
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
import { openStateDatabase } from "@/state/database";
import { LeaseStore } from "@/state/lease-store";

/** Directories and databases to release after each test. */
const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse())
    cleanup();
});

/** A failure used for retries and dead-letters. */
const failure = { code: "HOLQA_HANDLER_FAILED", message: "The handler failed.", attempt: 1 };

/**
 * Opens a store in a fresh directory.
 *
 * @param path - An existing state directory to reopen, as after a restart.
 * @returns The store, its clock, its database and its directory.
 */
function open(path?: string): { readonly store: LeaseStore; readonly clock: ManualClock; readonly database: Database; readonly path: string } {
  let directory = path;
  if (directory === undefined) {
    const created = stateDirectory();
    cleanups.push(created.remove);
    directory = created.path;
  }
  const database = openStateDatabase(directory);
  cleanups.push(() => database.close());
  const clock = new ManualClock(1_000_000);
  return { store: new LeaseStore({ database, clock, createId: sequentialIds("lease-"), pollIntervalMs: 60_000, retentionMs: 10_000 }), clock, database, path: directory };
}

describe("LeaseStore", () => {
  it("leases each due delivery to one receiver and redelivers it with a higher attempt when the lease expires", async () => {
    const { store, clock } = open();
    store.add("c", "m-1", "\"a\"");
    const source = store.source("c", body => JSON.parse(body) as string);
    const [first] = await source.receive({ max: 10, leaseMs: 5_000 });
    expect(first).toMatchObject({ id: "m-1", attempt: 1, body: "a" });
    expect(await source.receive({ max: 10, leaseMs: 5_000 })).toEqual([]);
    clock.advance(5_000);
    const [second] = await source.receive({ max: 10, leaseMs: 5_000 });
    expect(second).toMatchObject({ id: "m-1", attempt: 2 });
    // The first receiver lost its lease: its settlement has no effect.
    expect(await source.acknowledge(first!.receipt)).toBe(false);
    expect(await source.acknowledge(second!.receipt)).toBe(true);
    expect(store.list("c").map(delivery => delivery.state)).toEqual(["acknowledged"]);
  });

  it("extends a held lease, and refuses to extend a lost one", async () => {
    const { store, clock } = open();
    store.add("c", "m-1", "1");
    const source = store.source("c", Number);
    const [delivery] = await source.receive({ max: 1, leaseMs: 1_000 });
    clock.advance(900);
    expect(await source.extend!(delivery!.receipt, 1_000)).toBe(true);
    clock.advance(900);
    expect(await source.receive({ max: 1, leaseMs: 1_000 })).toEqual([]);
    clock.advance(100);
    const [again] = await source.receive({ max: 1, leaseMs: 1_000 });
    expect(again?.attempt).toBe(2);
    expect(await source.extend!(delivery!.receipt, 1_000)).toBe(false);
  });

  it("dead-letters a stored body that cannot be decoded instead of failing the receive", async () => {
    const { store } = open();
    store.add("c", "bad", "not json");
    store.add("c", "good", "2");
    const source = store.source("c", body => JSON.parse(body) as number);
    expect((await source.receive({ max: 5, leaseMs: 1_000 })).map(delivery => delivery.id)).toEqual(["good"]);
    expect(store.list("c", ["dead"])).toMatchObject([{ id: "bad", lastError: { code: "HOLQA_PAYLOAD_MALFORMED" } }]);
  });

  it("delays retries and records the failure", async () => {
    const { store, clock } = open();
    store.add("c", "m-1", "1");
    const source = store.source("c", Number);
    const [delivery] = await source.receive({ max: 1, leaseMs: 1_000 });
    expect(await source.retry(delivery!.receipt, 3_000, failure)).toBe(true);
    expect(await source.receive({ max: 1, leaseMs: 1_000 })).toEqual([]);
    clock.advance(3_000);
    expect(await source.receive({ max: 1, leaseMs: 1_000 })).toMatchObject([{ attempt: 2 }]);
    expect(store.list("c")[0]?.lastError).toEqual({ code: "HOLQA_HANDLER_FAILED", message: "The handler failed." });
  });

  it("dead-letters, redrives with a fresh attempt count, discards and purges", async () => {
    const { store } = open();
    store.add("c", "m-1", "1");
    store.add("c", "m-2", "2");
    const source = store.source("c", Number);
    const [one, two] = await source.receive({ max: 2, leaseMs: 1_000 });
    await source.deadLetter(one!.receipt, failure);
    await source.discard(two!.receipt, failure);
    expect(store.list("c").map(delivery => `${delivery.id}:${delivery.state}`)).toEqual(["m-1:dead"]);
    expect(store.redrive("c")).toBe(1);
    expect(store.list("c", ["ready"]).map(delivery => delivery.attempts)).toEqual([0]);
    expect(store.purge("c")).toBe(1);
    expect(store.list("c")).toEqual([]);
  });

  it("copies a known delivery with the same identity to simulate duplicate delivery", async () => {
    const { store } = open();
    store.add("c", "m-1", "1");
    expect(store.duplicate("c", "m-1")).toBe(true);
    expect(store.duplicate("c", "unknown")).toBe(false);
    const source = store.source("c", Number);
    expect((await source.receive({ max: 5, leaseMs: 1_000 })).map(delivery => delivery.id)).toEqual(["m-1", "m-1"]);
  });

  it("keeps deliveries across a restart, and expires the leases of a crashed receiver", async () => {
    const first = open();
    first.store.add("c", "m-1", "1");
    await first.store.source("c", Number).receive({ max: 1, leaseMs: 10_000 });
    first.database.close();
    const second = open(first.path);
    const source = second.store.source("c", Number);
    // The restarted clock starts at the same time: the old lease still holds.
    expect(await source.receive({ max: 1, leaseMs: 10_000 })).toEqual([]);
    second.clock.advance(10_000);
    expect(await source.receive({ max: 1, leaseMs: 10_000 })).toMatchObject([{ id: "m-1", attempt: 2 }]);
  });

  it("wakes waiting receivers when work is added, when a delay ends and when aborted", async () => {
    const { store, clock } = open();
    const source = store.source("c", Number);
    const controller = new AbortController();
    let woke = 0;
    const waiting = source.wait(controller.signal).then(() => woke += 1);
    store.add("c", "m-1", "1", 0);
    store.notify("c");
    await waiting;
    expect(woke).toBe(1);
    store.add("c", "m-2", "2", 2_000);
    await source.receive({ max: 1, leaseMs: 60_000 });
    const delayed = source.wait(controller.signal).then(() => woke += 1);
    clock.advance(2_000);
    await delayed;
    expect(woke).toBe(2);
    const aborted = source.wait(controller.signal).then(() => woke += 1);
    controller.abort();
    await aborted;
    expect(woke).toBe(3);
  });

  it("prunes acknowledged deliveries after the retention period and reports busy channels", async () => {
    const { store, clock } = open();
    store.add("c", "m-1", "1");
    const source = store.source("c", Number);
    expect(store.busyChannels()).toEqual(["c"]);
    const [delivery] = await source.receive({ max: 1, leaseMs: 1_000 });
    expect(store.busyChannels()).toEqual(["c"]);
    await source.acknowledge(delivery!.receipt);
    expect(store.busyChannels()).toEqual([]);
    clock.advance(10_001);
    store.prune();
    expect(store.list("c")).toEqual([]);
  });
});