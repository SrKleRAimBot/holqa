import {
  describe,
  expect,
  it
} from "bun:test";

import {
  Semaphore,
  SemaphoreFullError
} from "@/dispatch/semaphore";

describe("Semaphore", () => {
  it("grants up to its limit and serves waiters in arrival order", async () => {
    const semaphore = new Semaphore(1);
    const first = await semaphore.acquire();
    const order: string[] = [];
    const second = semaphore.acquire().then((release) => {
      order.push("second");
      return release;
    });
    const third = semaphore.acquire().then((release) => {
      order.push("third");
      return release;
    });
    expect([semaphore.held, semaphore.waiting]).toEqual([1, 2]);
    first();
    (await second)();
    (await third)();
    expect(order).toEqual(["second", "third"]);
    expect([semaphore.held, semaphore.waiting, semaphore.peak]).toEqual([0, 0, 1]);
  });

  it("makes release idempotent", async () => {
    const semaphore = new Semaphore(2);
    const release = await semaphore.acquire();
    await semaphore.acquire();
    release();
    release();
    expect(semaphore.held).toBe(1);
  });

  it("rejects when the wait queue is full", async () => {
    const semaphore = new Semaphore(1, 1);
    await semaphore.acquire();
    void semaphore.acquire();
    await expect(semaphore.acquire()).rejects.toBeInstanceOf(SemaphoreFullError);
  });

  it("removes an aborted waiter from the queue", async () => {
    const semaphore = new Semaphore(1);
    const release = await semaphore.acquire();
    const controller = new AbortController();
    const waiting = semaphore.acquire(controller.signal);
    controller.abort(new Error("gave up"));
    await expect(waiting).rejects.toThrow("gave up");
    expect(semaphore.waiting).toBe(0);
    release();
    expect(semaphore.held).toBe(0);
    await expect(semaphore.acquire(AbortSignal.abort(new Error("already")))).rejects.toThrow("already");
  });
});