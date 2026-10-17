import {
  describe,
  expect,
  it
} from "bun:test";

import { Semaphore } from "@/semaphore";

describe("Semaphore", () => {
  it("grants slots in FIFO order and tracks the peak", async () => {
    const semaphore = new Semaphore(1);
    const order: number[] = [];
    const release = await semaphore.acquire();
    const waiting = [1, 2, 3].map(async (number) => {
      const done = await semaphore.acquire();
      order.push(number);
      done();
    });
    expect(semaphore.waiting).toBe(3);
    release();
    release();
    await Promise.all(waiting);
    expect(order).toEqual([1, 2, 3]);
    expect(semaphore.peak).toBe(1);
    expect(semaphore.held).toBe(0);
  });

  it("removes an aborted waiter and rejects with the abort reason", async () => {
    const semaphore = new Semaphore(1);
    const release = await semaphore.acquire();
    const controller = new AbortController();
    const waiting = semaphore.acquire(controller.signal);
    controller.abort(new Error("stop"));
    expect(waiting).rejects.toThrow("stop");
    expect(semaphore.waiting).toBe(0);
    release();
    expect(semaphore.held).toBe(0);
  });

  it("applies a raised limit to waiting acquirers immediately and never revokes held slots", async () => {
    const semaphore = new Semaphore(1);
    await semaphore.acquire();
    const second = semaphore.acquire();
    semaphore.setLimit(2);
    await second;
    semaphore.setLimit(1);
    expect(semaphore.held).toBe(2);
  });
});