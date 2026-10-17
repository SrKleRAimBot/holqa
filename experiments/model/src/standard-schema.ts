// Structural copies of the Standard Schema interfaces
// (https://standardschema.dev, @standard-schema/spec 1.1.0, MIT licensed).
// The specification recommends copying the interfaces instead of depending on
// a package. The spec groups helper types in a namespace; this copy uses flat
// names instead, which is structurally identical, so any spec-compliant schema
// (Zod, Valibot, ArkType, ...) satisfies these types.

/** The properties every Standard Schema exposes under `~standard`. */
export interface StandardSchemaProps<Input = unknown, Output = Input> {
  readonly version: 1;
  readonly vendor: string;
  readonly validate: (value: unknown, options?: StandardSchemaOptions | undefined) => StandardSchemaResult<Output> | Promise<StandardSchemaResult<Output>>;
  readonly types?: StandardSchemaTypes<Input, Output> | undefined;
}

/** A schema that exposes validation and inferred types through the `~standard` property. */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly "~standard": StandardSchemaProps<Input, Output>;
}

/** The result of validating a value. */
export type StandardSchemaResult<Output> = StandardSchemaSuccess<Output> | StandardSchemaFailure;

/** A successful validation result. */
export interface StandardSchemaSuccess<Output> {
  readonly value: Output;
  readonly issues?: undefined;
}

/** A failed validation result. */
export interface StandardSchemaFailure {
  readonly issues: ReadonlyArray<StandardSchemaIssue>;
}

/** Options accepted by `validate`. */
export interface StandardSchemaOptions {
  readonly libraryOptions?: Record<string, unknown> | undefined;
}

/** One validation problem. */
export interface StandardSchemaIssue {
  readonly message: string;
  readonly path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }> | undefined;
}

/** The phantom input and output types of a schema. */
export interface StandardSchemaTypes<Input = unknown, Output = Input> {
  readonly input: Input;
  readonly output: Output;
}

/** The type a schema accepts (what a producer sends). */
export type InferInput<Schema extends StandardSchemaV1> = NonNullable<Schema["~standard"]["types"]>["input"];

/** The type a schema produces after validation and transformation (what a consumer receives). */
export type InferOutput<Schema extends StandardSchemaV1> = NonNullable<Schema["~standard"]["types"]>["output"];

/** The JSON Schema dialect a Standard JSON Schema converter should produce. */
export type StandardJsonSchemaTarget = "draft-2020-12" | "draft-07" | "openapi-3.0" | ({} & string);

/** Options accepted by Standard JSON Schema converter functions. */
export interface StandardJsonSchemaOptions {
  readonly target: StandardJsonSchemaTarget;
  readonly libraryOptions?: Record<string, unknown> | undefined;
}

/** Converts the input or output side of a schema to JSON Schema. Either side may throw. */
export interface StandardJsonSchemaConverter {
  readonly input: (options: StandardJsonSchemaOptions) => Record<string, unknown>;
  readonly output: (options: StandardJsonSchemaOptions) => Record<string, unknown>;
}

/** A schema that can convert itself to JSON Schema (the Standard JSON Schema extension). */
export interface StandardJsonSchemaV1<Input = unknown, Output = Input> {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly types?: StandardSchemaTypes<Input, Output> | undefined;
    readonly jsonSchema: StandardJsonSchemaConverter;
  };
}

/**
 * Reports whether a value structurally implements Standard Schema v1.
 *
 * @param value - The value to inspect, typically a user-supplied schema.
 * @returns `true` when `value["~standard"]` has version `1`, a vendor and a `validate` function.
 */
export function isStandardSchema(value: unknown): value is StandardSchemaV1 {
  if ((typeof value !== "object" && typeof value !== "function") || value === null || !("~standard" in value))
    return false;
  const props: unknown = value["~standard"];
  return typeof props === "object" && props !== null
    && "version" in props && props.version === 1
    && "vendor" in props && typeof props.vendor === "string"
    && "validate" in props && typeof props.validate === "function";
}

/**
 * Reports whether a Standard Schema also implements the Standard JSON Schema converter.
 *
 * @param schema - A Standard Schema.
 * @returns `true` when `~standard.jsonSchema.input` and `.output` are functions.
 */
export function hasStandardJsonSchema(schema: StandardSchemaV1): schema is StandardSchemaV1 & StandardJsonSchemaV1 {
  const props: object = schema["~standard"];
  if (!("jsonSchema" in props))
    return false;
  const converter: unknown = props.jsonSchema;
  return typeof converter === "object" && converter !== null
    && "input" in converter && typeof converter.input === "function"
    && "output" in converter && typeof converter.output === "function";
}