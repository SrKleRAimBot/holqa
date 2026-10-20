import type {
  ApplicationScope,
  ScopedDefinition
} from "@holqa/core";

import type { StructuredLogger } from "@/logging/log";

import {
  diagnosticCodes,
  failWith
} from "@holqa/core";

import { describeError } from "@/logging/log";

/** A created scoped value and how to dispose of it. */
interface ScopedEntry {
  readonly definition: ScopedDefinition<unknown>;
  readonly value: unknown;
}

/**
 * The application execution context of one runtime: it creates scoped values
 * on first use, shares them between invocations, and disposes of them in
 * reverse creation order when the runtime stops. Each runtime has its own, so
 * separately started runtimes never share values.
 *
 * Handler versions use the scope through views ({@link RuntimeScope.open}),
 * which record which version used which definition. When a replaced version
 * retires ({@link RuntimeScope.release}), its view's signal is aborted and
 * the values that no remaining version used are disposed of, so values a
 * replaced module created are not kept alive by the runtime.
 */
export class RuntimeScope {
  /** Aborted when the runtime starts stopping. */
  private readonly controller = new AbortController();
  /** Values being created or created, by definition. */
  private readonly pending = new Map<ScopedDefinition<unknown>, Promise<unknown>>();
  /** Created values, in creation order. */
  private readonly created: ScopedEntry[] = [];
  /** The open views that used each definition. */
  private readonly users = new Map<ScopedDefinition<unknown>, Set<object>>();
  /** The open views, with their abort controllers and the definitions they used. */
  private readonly views = new Map<object, { readonly controller: AbortController; readonly used: Set<ScopedDefinition<unknown>>; readonly view: ApplicationScope }>();
  /** Where disposal failures are reported. */
  private readonly logger: StructuredLogger;
  /** Whether values may still be created. */
  private accepting = true;

  /** The handler-facing view of this scope. */
  readonly scope: ApplicationScope;

  /**
   * Creates an empty scope.
   *
   * @param logger - Where disposal failures are reported.
   */
  constructor(logger: StructuredLogger) {
    this.logger = logger;
    this.scope = Object.freeze<ApplicationScope>({
      signal: this.controller.signal,
      use: definition => this.useFor(this, definition)
    });
  }

  /**
   * Returns a definition's value, creating it on first use. Concurrent first
   * uses share one creation; a failed creation is not cached.
   *
   * @param definition - The scoped definition, which identifies the value.
   * @returns The value.
   * @throws {HolqaError} `HOLQA_RUNTIME_NOT_RUNNING` once the runtime is stopping; whatever `create` throws.
   */
  private async use<Value>(definition: ScopedDefinition<Value>): Promise<Value> {
    const existing = this.pending.get(definition as ScopedDefinition<unknown>);
    if (existing !== undefined)
      return existing as Promise<Value>;
    if (!this.accepting)
      failWith(diagnosticCodes.runtimeNotRunning, `The scoped value "${definition.name}" was requested while the runtime is stopping.`);
    const creation = (async () => {
      const value = await definition.create(this.scope);
      if (!this.accepting) {
        // The runtime began stopping while the value was being created:
        // release it at once instead of handing out a value nobody disposes of.
        await this.disposeEntry({ definition: definition as ScopedDefinition<unknown>, value });
        failWith(diagnosticCodes.runtimeNotRunning, `The scoped value "${definition.name}" was created while the runtime was stopping and has been disposed of.`);
      }
      this.created.push({ definition: definition as ScopedDefinition<unknown>, value });
      return value;
    })();
    this.pending.set(definition as ScopedDefinition<unknown>, creation);
    creation.catch(() => this.pending.delete(definition as ScopedDefinition<unknown>));
    return creation;
  }

  /**
   * Opens a view of the scope for one owner, such as one handler version. The
   * view shares values with every other view, records which definitions its
   * owner used, and has a signal that aborts when the runtime stops or when
   * the owner is {@link release}d.
   *
   * @param owner - Any object that identifies the owner.
   * @returns The owner's view, the same one for repeated calls.
   */
  open(owner: object): ApplicationScope {
    const existing = this.views.get(owner);
    if (existing !== undefined)
      return existing.view;
    const controller = new AbortController();
    const view = Object.freeze<ApplicationScope>({
      signal: AbortSignal.any([this.controller.signal, controller.signal]),
      use: definition => this.useFor(owner, definition)
    });
    this.views.set(owner, { controller, used: new Set(), view });
    return view;
  }

  /**
   * Releases an owner's view: aborts its signal and disposes of every value
   * that the owner used and no other open view used. Values used through
   * {@link scope} directly are kept until the runtime stops. A later use of
   * a disposed definition creates a fresh value.
   *
   * @param owner - The owner given to {@link open}.
   * @returns The number of values whose disposal failed.
   */
  async release(owner: object): Promise<number> {
    const view = this.views.get(owner);
    if (view === undefined)
      return 0;
    this.views.delete(owner);
    view.controller.abort();
    const orphaned: ScopedDefinition<unknown>[] = [];
    for (const definition of view.used) {
      const users = this.users.get(definition);
      users?.delete(owner);
      if (users === undefined || users.size === 0) {
        this.users.delete(definition);
        orphaned.push(definition);
      }
    }
    let failures = 0;
    // Detach synchronously, so a use that arrives while disposal runs creates a fresh value.
    const detached = orphaned.map((definition) => {
      const creation = this.pending.get(definition);
      this.pending.delete(definition);
      return { definition, creation };
    });
    for (const { definition, creation } of detached.reverse()) {
      if (creation === undefined)
        continue;
      const value = await creation.then(created => ({ created }), () => undefined);
      if (value === undefined)
        continue;
      const index = this.created.findIndex(entry => entry.definition === definition && entry.value === value.created);
      // Not found: the runtime's stop already disposed of it.
      if (index === -1)
        continue;
      this.created.splice(index, 1);
      if (!await this.disposeEntry({ definition, value: value.created }))
        failures += 1;
    }
    return failures;
  }

  /**
   * Records that an owner uses a definition, then returns its value. The
   * scope itself is an owner that is never released: values it uses live
   * until the runtime stops.
   *
   * @param owner - The owner of a view, or the scope itself for direct uses.
   * @param definition - The scoped definition.
   * @returns The definition's value.
   */
  private useFor<Value>(owner: object, definition: ScopedDefinition<Value>): Promise<Value> {
    this.views.get(owner)?.used.add(definition as ScopedDefinition<unknown>);
    if (owner === this || this.views.has(owner))
      this.addUser(owner, definition as ScopedDefinition<unknown>);
    return this.use(definition);
  }

  /**
   * Records that an owner uses a definition.
   *
   * @param owner - The owner, or the scope itself for direct uses.
   * @param definition - The definition it uses.
   */
  private addUser(owner: object, definition: ScopedDefinition<unknown>): void {
    const users = this.users.get(definition) ?? new Set();
    users.add(owner);
    this.users.set(definition, users);
  }

  /**
   * Counts the values created and not yet disposed of.
   *
   * @returns How many values the scope holds.
   */
  get size(): number {
    return this.created.length;
  }

  /** Marks the scope as stopping: aborts its signal and refuses new values. */
  close(): void {
    this.accepting = false;
    this.controller.abort();
  }

  /**
   * Disposes of every created value in reverse creation order. A failing
   * `dispose` is logged and does not prevent the others.
   *
   * @returns The number of values whose disposal failed.
   */
  async dispose(): Promise<number> {
    this.close();
    let failures = 0;
    for (const entry of this.created.splice(0).reverse()) {
      if (!await this.disposeEntry(entry))
        failures += 1;
    }
    this.pending.clear();
    this.users.clear();
    this.views.clear();
    return failures;
  }

  /**
   * Disposes of one value.
   *
   * @param entry - The value and its definition.
   * @returns `true` when disposal succeeded or the definition has no `dispose`.
   */
  private async disposeEntry(entry: ScopedEntry): Promise<boolean> {
    try {
      await entry.definition.dispose?.(entry.value);
      return true;
    } catch (error) {
      this.logger.write("error", "disposing of a scoped value failed", { scoped: entry.definition.name, error: describeError(error) });
      return false;
    }
  }
}