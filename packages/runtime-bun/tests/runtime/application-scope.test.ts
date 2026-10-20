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

  it("releases a view: aborts its signal and disposes of values no other view used", async () => {
    const disposed: string[] = [];
    const scope = new RuntimeScope(new StructuredLogger(silentSink));
    const first = scope.open({});
    const ownerB = {};
    const second = scope.open(ownerB);
    /**
     * Creates a definition that records its disposal.
     *
     * @param name - The value it creates, also its name.
     * @returns A scoped definition whose disposal is recorded.
     */
    const definition = (name: string): { readonly name: string; readonly create: () => string; readonly dispose: (value: string) => void } => ({ name, create: () => name, dispose: value => void disposed.push(value) });
    const shared = definition("shared");
    const own = definition("own");
    await first.use(shared);
    await first.use(own);
    await second.use(shared);
    expect(scope.size).toBe(2);
    expect(await scope.release(ownerB)).toBe(0);
    expect(second.signal.aborted).toBe(true);
    expect(first.signal.aborted).toBe(false);
    // The second view used only the shared value, which the first still uses.
    expect(disposed).toEqual([]);
    expect(scope.size).toBe(2);
  });

  it("disposes of a released owner's values and creates a fresh value on the next use", async () => {
    const disposed: number[] = [];
    let created = 0;
    const scope = new RuntimeScope(new StructuredLogger(silentSink));
    const owner = {};
    const view = scope.open(owner);
    const definition = { name: "pool", create: () => ++created, dispose: (value: number) => void disposed.push(value) };
    expect(await view.use(definition)).toBe(1);
    await scope.release(owner);
    expect(disposed).toEqual([1]);
    expect(scope.size).toBe(0);
    expect(await scope.open({}).use(definition)).toBe(2);
  });

  it("never disposes of values used through the scope itself before the runtime stops", async () => {
    const disposed: string[] = [];
    const scope = new RuntimeScope(new StructuredLogger(silentSink));
    const owner = {};
    const definition = { name: "client", create: () => "client", dispose: (value: string) => void disposed.push(value) };
    await scope.open(owner).use(definition);
    await scope.scope.use(definition);
    await scope.release(owner);
    expect(disposed).toEqual([]);
    await scope.dispose();
    expect(disposed).toEqual(["client"]);
  });
});