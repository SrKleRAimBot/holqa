/**
 * How to create, and optionally dispose of, a value that lives as long as one
 * application execution context: a connection pool, an SDK client, a cache.
 * The definition object itself is the key: every `use` of the same
 * definition in one execution context returns the same value.
 *
 * @typeParam Value - What `create` returns and every `use` resolves to.
 */
export interface ScopedDefinition<Value> {
  /** A short name used in logs and diagnostics, for example `database`. */
  readonly name: string;
  /**
   * Creates the value. Called at most once per execution context, the first
   * time an invocation uses the definition. A failure is not cached: the next
   * use tries again.
   */
  readonly create: (scope: ApplicationScope) => Value | Promise<Value>;
  /** Releases the value when the execution context stops. Values are disposed in reverse creation order. */
  readonly dispose?: (value: Value) => void | Promise<void>;
}

/**
 * The application execution context an invocation runs in. Values created
 * through it are shared by every invocation of that context and released when
 * it stops; per-invocation state belongs in the invocation context instead.
 *
 * A runtime creates one scope per started application instance. Separate
 * instances (for example two runtimes, or an isolated worker) never share
 * scoped values.
 */
export interface ApplicationScope {
  /** Aborted when the execution context starts stopping. */
  readonly signal: AbortSignal;
  /**
   * Returns the value of a scoped definition, creating it on first use.
   * Concurrent first uses share one creation.
   */
  readonly use: <Value>(definition: ScopedDefinition<Value>) => Promise<Value>;
}