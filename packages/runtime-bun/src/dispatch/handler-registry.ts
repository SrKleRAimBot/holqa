import type { ApplicationScope } from "@holqa/core";

import type { RegisteredHandler } from "@/dispatch/dispatcher";

/** Opens and releases the lifecycle scope of one handler version. */
export interface VersionLifecycle {
  /** Returns the application scope view the version's invocations receive. */
  readonly open: (owner: object) => ApplicationScope;
  /** Releases a retired version's view: aborts its signal and disposes of the values only it used. */
  readonly release: (owner: object) => Promise<unknown>;
  /** Called once a replaced version has no running invocation left and has been released; `error` is set when releasing failed. */
  readonly retired?: (handlerId: string, version: number, error?: unknown) => void;
}

/** One implementation of a handler: what runs, and how many executions still use it. */
interface VersionRecord {
  readonly handlerId: string;
  /** The registry version in which this implementation was installed. */
  readonly version: number;
  readonly invoke: RegisteredHandler["invoke"];
  /** Where it is implemented, `<module>#<export>`. */
  readonly source: string | undefined;
  /** Identifies the version's scope view. */
  readonly owner: object;
  /** The application scope view of its invocations. */
  readonly scope: ApplicationScope;
  /** Executions pinned to it that have not finished, including orphans. */
  active: number;
  /** `current` serves new invocations; `retiring` only finishes pinned ones. */
  state: "current" | "retiring";
}

/** A handler, its current implementation and the replaced ones still running. */
interface HandlerSlot {
  readonly handler: RegisteredHandler;
  current: VersionRecord;
  readonly retiring: Set<VersionRecord>;
}

/** An execution pinned to one handler version. */
export interface PinnedVersion {
  readonly version: number;
  readonly invoke: RegisteredHandler["invoke"];
  readonly scope: ApplicationScope;
  /** Unpins the execution; call it exactly once, when the handler's code has finished. */
  readonly release: () => void;
}

/** The versions of one handler, as {@link HandlerRegistry.snapshot} reports them. */
export interface HandlerVersionInfo {
  readonly handlerId: string;
  /** The registry version in which the current implementation was installed; 1 for the initial one. */
  readonly version: number;
  /** Where the current implementation is, `<module>#<export>`, when known. */
  readonly source?: string;
  /** Executions of the current implementation that have not finished. */
  readonly active: number;
  /** Replaced implementations that still have running executions. */
  readonly retiring: ReadonlyArray<{ readonly version: number; readonly active: number }>;
}

/** Counters of a {@link HandlerRegistry}. */
export interface HandlerRegistryStats {
  /** The registry version: 1 initially, plus one per replacement. */
  readonly version: number;
  /** Replaced implementations that still have running executions. */
  readonly retiring: number;
  /** Replaced implementations that finished their executions and were released. */
  readonly retired: number;
}

/** A replacement implementation of a registered handler. */
export interface HandlerReplacementEntry {
  readonly handlerId: string;
  readonly invoke: RegisteredHandler["invoke"];
  readonly source?: string;
}

/**
 * The versioned handler registry. Each handler identifier has one current
 * implementation; a replacement installs new implementations for several
 * handlers at once, atomically, as one new registry version. An execution is
 * pinned to the implementation that is current when it starts, and keeps it
 * until it finishes, so in-flight work completes under the code it started
 * with while new work runs the new code. A replaced implementation retires
 * once its last pinned execution has finished: its lifecycle scope is then
 * released.
 *
 * The handler's definition, schemas and concurrency limit belong to the
 * handler, not to a version: they are shared by every implementation, so a
 * replacement never changes how many executions may run at once or which
 * trigger delivers them.
 */
export class HandlerRegistry {
  /** Handlers by identifier. */
  private readonly slots = new Map<string, HandlerSlot>();
  /** Opens and releases version scopes. */
  private readonly lifecycle: VersionLifecycle;
  /** The current registry version: 1, plus one per replacement. */
  private version = 1;
  /** Released versions. */
  private retired = 0;
  /** Releases still running. */
  private readonly releasing = new Set<Promise<void>>();

  /**
   * Creates a registry whose initial implementations are the handlers' own.
   *
   * @param handlers - The registered handlers by identifier.
   * @param lifecycle - Opens and releases version scopes.
   * @param sources - Where each handler is implemented, by identifier.
   */
  constructor(handlers: ReadonlyMap<string, RegisteredHandler>, lifecycle: VersionLifecycle, sources: ReadonlyMap<string, string> = new Map()) {
    this.lifecycle = lifecycle;
    for (const [handlerId, handler] of handlers) {
      const record = this.record(handlerId, 1, handler.invoke, sources.get(handlerId));
      this.slots.set(handlerId, { handler, current: record, retiring: new Set() });
    }
  }

  /**
   * Returns a registered handler.
   *
   * @param handlerId - The handler's identifier.
   * @returns The handler, or `undefined` when none is registered with the identifier.
   */
  get(handlerId: string): RegisteredHandler | undefined {
    return this.slots.get(handlerId)?.handler;
  }

  /**
   * Returns where a handler's current implementation is.
   *
   * @param handlerId - The handler's identifier.
   * @returns `<module>#<export>`, or `undefined` when unknown.
   */
  source(handlerId: string): string | undefined {
    return this.slots.get(handlerId)?.current.source;
  }

  /**
   * Pins an execution to a handler's current implementation.
   *
   * @param handlerId - A registered handler's identifier.
   * @returns The pinned implementation.
   * @throws {Error} When no handler is registered with the identifier; the dispatcher checks first.
   */
  pin(handlerId: string): PinnedVersion {
    const slot = this.slots.get(handlerId);
    if (slot === undefined)
      throw new Error(`No handler "${handlerId}" is registered.`);
    const record = slot.current;
    record.active += 1;
    let released = false;
    return {
      version: record.version,
      invoke: record.invoke,
      scope: record.scope,
      release: () => {
        if (released)
          return;
        released = true;
        record.active -= 1;
        if (record.state === "retiring" && record.active === 0)
          this.retire(slot, record);
      }
    };
  }

  /**
   * Installs new implementations of registered handlers as one new registry
   * version. Every entry must name a registered handler, at most once; the
   * caller checks that definitions did not change.
   *
   * @param entries - The new implementations.
   * @returns The new registry version and the replaced handlers, sorted.
   * @throws {Error} When an entry names an unknown handler or a handler twice; nothing is replaced then.
   */
  replace(entries: readonly HandlerReplacementEntry[]): { readonly version: number; readonly handlers: readonly string[] } {
    const seen = new Set<string>();
    for (const entry of entries) {
      if (!this.slots.has(entry.handlerId) || seen.has(entry.handlerId))
        throw new Error(`The replacement names "${entry.handlerId}" twice or names an unknown handler.`);
      seen.add(entry.handlerId);
    }
    const version = ++this.version;
    for (const entry of entries) {
      const slot = this.slots.get(entry.handlerId)!;
      const previous = slot.current;
      slot.current = this.record(entry.handlerId, version, entry.invoke, entry.source ?? previous.source);
      previous.state = "retiring";
      slot.retiring.add(previous);
      if (previous.active === 0)
        this.retire(slot, previous);
    }
    return { version, handlers: [...seen].sort() };
  }

  /**
   * Describes every handler's current and retiring implementations.
   *
   * @returns One entry per handler, sorted by identifier.
   */
  snapshot(): readonly HandlerVersionInfo[] {
    return Object.freeze([...this.slots.entries()]
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([handlerId, slot]): HandlerVersionInfo => Object.freeze({
        handlerId,
        version: slot.current.version,
        ...slot.current.source === undefined ? {} : { source: slot.current.source },
        active: slot.current.active,
        retiring: Object.freeze([...slot.retiring].map(record => Object.freeze({ version: record.version, active: record.active })))
      })));
  }

  /**
   * Returns the registry's counters.
   *
   * @returns A snapshot.
   */
  stats(): HandlerRegistryStats {
    let retiring = 0;
    for (const slot of this.slots.values())
      retiring += slot.retiring.size;
    return Object.freeze({ version: this.version, retiring, retired: this.retired });
  }

  /**
   * Creates a version record with its own scope view.
   *
   * @param handlerId - The identifier of the handler it implements.
   * @param version - The registry version it is installed in.
   * @param invoke - Its implementation.
   * @param source - Where it is implemented.
   * @returns The record, current.
   */
  private record(handlerId: string, version: number, invoke: RegisteredHandler["invoke"], source: string | undefined): VersionRecord {
    const owner = Object.freeze({ handlerId, version });
    return { handlerId, version, invoke, source, owner, scope: this.lifecycle.open(owner), active: 0, state: "current" };
  }

  /**
   * Retires a replaced version that has no running execution: forgets it and
   * releases its scope.
   *
   * @param slot - Its handler.
   * @param record - The version.
   */
  private retire(slot: HandlerSlot, record: VersionRecord): void {
    if (!slot.retiring.delete(record))
      return;
    this.retired += 1;
    const releasing: Promise<void> = Promise.resolve()
      .then(() => this.lifecycle.release(record.owner))
      .then(() => this.lifecycle.retired?.(record.handlerId, record.version), (error: unknown) => this.lifecycle.retired?.(record.handlerId, record.version, error))
      .finally(() => this.releasing.delete(releasing));
    this.releasing.add(releasing);
  }

  /**
   * Waits until every retired version has been released, so a stopping
   * runtime disposes of the remaining values only afterwards.
   *
   * @returns A promise that settles once no release is running.
   */
  async released(): Promise<void> {
    while (this.releasing.size > 0)
      await Promise.all([...this.releasing]);
  }
}