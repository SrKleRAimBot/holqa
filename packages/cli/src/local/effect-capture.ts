// Detects what module evaluation does to the process outside the module
// itself. A hot swap evaluates new copies of modules in a running process; a
// module that starts a timer, adds a process listener or opens a server at
// its top level would leave the previous copy's resources running next to
// the new ones. Evaluation is synchronous (`require` of an ES module without
// top-level await), so for its duration every call to the patched APIs comes
// from module code, and attribution is exact.

/** One effect of module evaluation on the process. */
export interface CapturedEffect {
  /** The API that was called, for example `setInterval` or `process.on`. */
  readonly api: string;
  /** Undoes the effect: clears the timer, removes the listener, stops the server. */
  readonly undo: () => void;
}

/** The result of {@link captureEffects}. */
export interface EffectCapture<Value> {
  readonly value: Value;
  /** Every effect, in call order. */
  readonly effects: readonly CapturedEffect[];
  /** Global names that evaluation added to `globalThis`. */
  readonly globals: readonly string[];
}

/** Methods of `process` that add an event listener. */
const listenerMethods = ["on", "addListener", "once", "prependListener", "prependOnceListener"] as const;

/** Bun APIs that open servers, sockets or processes. */
const bunResourceApis = ["serve", "listen", "connect", "udpSocket", "spawn"] as const;

/** Global constructors that open threads or connections. */
const resourceConstructors = ["Worker", "WebSocket"] as const;

/**
 * Stops a resource a Bun API returned, by whichever method it has.
 *
 * @param resource - What the API returned.
 */
function stopResource(resource: unknown): void {
  if (typeof resource !== "object" || resource === null)
    return;
  const candidate = resource as { readonly stop?: (force?: boolean) => unknown; readonly kill?: () => unknown; readonly close?: () => unknown; readonly terminate?: () => unknown; readonly end?: () => unknown };
  if (typeof candidate.stop === "function")
    void candidate.stop(true);
  else if (typeof candidate.terminate === "function")
    void candidate.terminate();
  else if (typeof candidate.kill === "function")
    void candidate.kill();
  else if (typeof candidate.close === "function")
    void candidate.close();
  else if (typeof candidate.end === "function")
    void candidate.end();
}

/**
 * Runs a synchronous function (module evaluation) while recording the
 * timers, process and global event listeners, servers, sockets, processes,
 * workers and global names it creates. The effects are left in place; the
 * caller decides whether to keep them or undo them.
 *
 * Only these APIs are observed. Effects through other means (for example a
 * `node:net` server, or a connection a library opens) are not detected.
 *
 * @param run - The synchronous function to observe.
 * @returns Its value, its effects and the global names it added.
 * @throws Whatever `run` throws, after the patched APIs are restored and the effects so far undone.
 */
export function captureEffects<Value>(run: () => Value): EffectCapture<Value> {
  const effects: CapturedEffect[] = [];
  const restores: Array<() => void> = [];
  const target = globalThis as unknown as Record<string, unknown>;
  const before = new Set(Object.getOwnPropertyNames(globalThis));
  /**
   * Replaces a property for the duration of the capture.
   *
   * @param owner - The object that holds it.
   * @param name - The property.
   * @param replacement - Builds the replacement from the original.
   */
  const patch = (owner: Record<string, unknown>, name: string, replacement: (original: (...args: unknown[]) => unknown) => unknown): void => {
    const original = owner[name];
    if (typeof original !== "function")
      return;
    owner[name] = replacement(original as (...args: unknown[]) => unknown);
    restores.push(() => {
      owner[name] = original;
    });
  };
  patch(target, "setTimeout", original => (...args: unknown[]) => {
    const handle = original(...args) as ReturnType<typeof setTimeout>;
    effects.push({ api: "setTimeout", undo: () => clearTimeout(handle) });
    return handle;
  });
  patch(target, "setInterval", original => (...args: unknown[]) => {
    const handle = original(...args) as ReturnType<typeof setInterval>;
    effects.push({ api: "setInterval", undo: () => clearInterval(handle) });
    return handle;
  });
  patch(target, "setImmediate", original => (...args: unknown[]) => {
    const handle = original(...args) as ReturnType<typeof setImmediate>;
    effects.push({ api: "setImmediate", undo: () => clearImmediate(handle) });
    return handle;
  });
  patch(target, "addEventListener", original => (...args: unknown[]) => {
    const [type, listener, options] = args as Parameters<typeof globalThis.removeEventListener>;
    effects.push({ api: "addEventListener", undo: () => globalThis.removeEventListener(type, listener, options) });
    return original(...args);
  });
  const processTarget = process as unknown as Record<string, unknown>;
  for (const method of listenerMethods) {
    patch(processTarget, method, original => function (this: unknown, ...args: unknown[]) {
      const [event, listener] = args as [string | symbol, (...values: unknown[]) => void];
      effects.push({ api: `process.${method}`, undo: () => process.removeListener(event, listener) });
      return original.apply(this, args);
    });
  }
  const bunTarget = Bun as unknown as Record<string, unknown>;
  for (const api of bunResourceApis) {
    patch(bunTarget, api, original => function (this: unknown, ...args: unknown[]) {
      const result = original.apply(this, args);
      if (result instanceof Promise)
        effects.push({ api: `Bun.${api}`, undo: () => void result.then(stopResource, () => {}) });
      else
        effects.push({ api: `Bun.${api}`, undo: () => stopResource(result) });
      return result;
    });
  }
  for (const name of resourceConstructors) {
    const original = target[name];
    if (typeof original !== "function")
      continue;
    const Original = original as new (...args: unknown[]) => object;
    target[name] = new Proxy(Original, {
      construct: (constructor, args: unknown[], newTarget) => {
        const instance = Reflect.construct(constructor, args, newTarget) as object;
        effects.push({ api: `new ${name}`, undo: () => stopResource(instance) });
        return instance;
      }
    });
    restores.push(() => {
      target[name] = original;
    });
  }
  /** Restores every patched API. */
  const restore = (): void => {
    for (const undo of restores.reverse())
      undo();
  };
  let value: Value;
  try {
    value = run();
  } catch (error) {
    restore();
    for (const effect of effects)
      effect.undo();
    throw error;
  }
  restore();
  const globals = Object.getOwnPropertyNames(globalThis).filter(name => !before.has(name)).sort();
  return { value, effects, globals };
}