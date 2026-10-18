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
 */
export class RuntimeScope {
  /** Aborted when the runtime starts stopping. */
  private readonly controller = new AbortController();
  /** Values being created or created, by definition. */
  private readonly pending = new Map<ScopedDefinition<unknown>, Promise<unknown>>();
  /** Created values, in creation order. */
  private readonly created: ScopedEntry[] = [];
  /** Where disposal failures are reported. */
  private readonly logger: StructuredLogger;
  /** Whether values may still be created. */
  private open = true;

  /** The handler-facing view of this scope. */
  readonly scope: ApplicationScope;

  /**
   * Creates an empty scope.
   *
   * @param logger - Where disposal failures are reported.
   */
  constructor(logger: StructuredLogger) {
    this.logger = logger;
    this.scope = Object.freeze({
      signal: this.controller.signal,
      use: this.use.bind(this)
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
    if (!this.open)
      failWith(diagnosticCodes.runtimeNotRunning, `The scoped value "${definition.name}" was requested while the runtime is stopping.`);
    const creation = (async () => {
      const value = await definition.create(this.scope);
      if (!this.open) {
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

  /** Marks the scope as stopping: aborts its signal and refuses new values. */
  close(): void {
    this.open = false;
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