import {
  describe,
  expect,
  it
} from "bun:test";

import {
  ManualClock,
  systemClock
} from "@/clock";

describe("ManualClock", () => {
  it("fires timers in due order while advancing, at their own due times", () => {
    const clock = new ManualClock(0);
    const fired: string[] = [];
    clock.setTimer(30, () => fired.push(`b@${clock.now()}`));
    clock.setTimer(10, () => {
      fired.push(`a@${clock.now()}`);
      clock.setTimer(5, () => fired.push(`c@${clock.now()}`));
    });
    const cancel = clock.setTimer(20, () => fired.push("cancelled"));
    cancel();
    clock.advance(25);
    expect(fired).toEqual(["a@10", "c@15"]);
    expect(clock.now()).toBe(25);
    clock.advance(5);
    expect(fired).toEqual(["a@10", "c@15", "b@30"]);
    expect(clock.pendingTimers()).toBe(0);
  });

  it("jumps first and fires due timers late, as after a suspended process", () => {
    const clock = new ManualClock(0);
    const fired: number[] = [];
    clock.setTimer(10, () => fired.push(clock.now()));
    clock.setTimer(20, () => fired.push(clock.now()));
    clock.jump(100);
    expect(fired).toEqual([100, 100]);
  });

  it("fires timers set with the same due time in creation order", () => {
    const clock = new ManualClock(0);
    const fired: number[] = [];
    for (const index of [1, 2, 3])
      clock.setTimer(5, () => fired.push(index));
    clock.advance(5);
    expect(fired).toEqual([1, 2, 3]);
  });
});

describe("systemClock", () => {
  it("reads the wall clock and runs platform timers", async () => {
    expect(Math.abs(systemClock.now() - Date.now())).toBeLessThan(1_000);
    const fired = await new Promise<boolean>((resolve) => {
      systemClock.setTimer(1, () => resolve(true));
    });
    expect(fired).toBe(true);
  });
});