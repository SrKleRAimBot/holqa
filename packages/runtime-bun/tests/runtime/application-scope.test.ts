import {
  describe,
  expect,
  it
} from "bun:test";

import { silentSink } from "@/index";
import { StructuredLogger } from "@/logging/log";
import { RuntimeScope } from "@/runtime/application-scope";

describe("RuntimeScope", () => {
  it("shares one creation between concurrent first uses", async () => {
    let created = 0;
    const scope = new RuntimeScope(new StructuredLogger(silentSink));
    const definition = { name: "pool", create: async () => ++created };
    expect(await Promise.all([scope.scope.use(definition), scope.scope.use(definition)])).toEqual([1, 1]);
    expect(created).toBe(1);
  });

  it("aborts its signal and refuses new values once closed", async () => {
    const scope = new RuntimeScope(new StructuredLogger(silentSink));
    scope.close();
    expect(scope.scope.signal.aborted).toBe(true);
    await expect(scope.scope.use({ name: "late", create: () => 1 })).rejects.toThrow("stopping");
  });

  it("disposes of a value whose creation finished after the scope closed", async () => {
    const disposed: number[] = [];
    let finish!: (value: number) => void;
    const scope = new RuntimeScope(new StructuredLogger(silentSink));
    const pending = scope.scope.use({ name: "slow", create: async () => new Promise<number>((resolve) => {
      finish = resolve;
    }), dispose: (value) => {
      disposed.push(value);
    } });
    await Bun.sleep(0);
    scope.close();
    finish(7);
    await expect(pending).rejects.toThrow("disposed");
    expect(disposed).toEqual([7]);
    expect(await scope.dispose()).toBe(0);
  });
});