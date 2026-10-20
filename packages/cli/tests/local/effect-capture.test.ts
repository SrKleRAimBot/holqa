import {
  describe,
  expect,
  it
} from "bun:test";

import { captureEffects } from "@/local/effect-capture";

describe("captureEffects", () => {
  it("records timers, process listeners and new globals, and undoes them", async () => {
    let fired = 0;
    /** A listener that does nothing. */
    const listener = (): void => {};
    const before = process.listenerCount("beforeExit");
    const capture = captureEffects(() => {
      setInterval(() => {
        fired += 1;
      }, 5);
      setTimeout(() => {
        fired += 1;
      }, 5);
      process.on("beforeExit", listener);
      Object.assign(globalThis, { __holqaCaptureTest: true });
      return "value";
    });
    expect(capture.value).toBe("value");
    expect(capture.effects.map(effect => effect.api)).toEqual(["setInterval", "setTimeout", "process.on"]);
    expect(capture.globals).toEqual(["__holqaCaptureTest"]);
    for (const effect of capture.effects)
      effect.undo();
    Reflect.deleteProperty(globalThis, "__holqaCaptureTest");
    await Bun.sleep(30);
    expect(fired).toBe(0);
    expect(process.listenerCount("beforeExit")).toBe(before);
  });

  it("restores the patched APIs and undoes the effects when the function throws", () => {
    const original = globalThis.setInterval;
    expect(() => captureEffects(() => {
      setInterval(() => {}, 1_000);
      throw new Error("evaluation failed");
    })).toThrow("evaluation failed");
    expect(globalThis.setInterval).toBe(original);
  });

  it("records nothing for modules without effects", () => {
    const capture = captureEffects(() => ({ handler: () => "ok", table: new Map([["a", 1]]) }));
    expect(capture.effects).toEqual([]);
    expect(capture.globals).toEqual([]);
  });
});