// Structural copies of the Standard Schema v1 interfaces
// (https://standardschema.dev, @standard-schema/spec 1.1.0, MIT licensed).
// The specification recommends copying the interfaces instead of depending on
// a package. The spec groups helper types in a namespace; these flat names are
// structurally identical, so any spec-compliant schema (Zod, Valibot, ArkType,
// a hand-written object, ...) satisfies them.

/** The properties every Standard Schema exposes under its `~standard` key. */
export interface StandardSchemaProps<Input = unknown, Output = Input> {
  readonly version: 1;
  readonly vendor: string;
  readonly validate: (value: unknown, options?: StandardSchemaOptions | undefined) => StandardSchemaResult<Output> | Promise<StandardSchemaResult<Output>>;
  readonly types?: StandardSchemaTypes<Input, Output> | undefined;
}

/** A schema that exposes validation and its inferred types through the `~standard` property. */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly "~standard": StandardSchemaProps<Input, Output>;
}

/** The result of validating a value: either the (possibly transformed) value or a list of issues. */
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

/** Library-specific options accepted by `validate`. */
export interface StandardSchemaOptions {
  readonly libraryOptions?: Record<string, unknown> | undefined;
}

/** One validation problem, with an optional path to the offending value. */
export interface StandardSchemaIssue {
  readonly message: string;
  readonly path?: ReadonlyArray<PropertyKey | StandardSchemaPathSegment> | undefined;
}

/** A path segment object, used by libraries that attach metadata to segments. */
export interface StandardSchemaPathSegment {
  readonly key: PropertyKey;
}

/** The phantom input and output types of a schema. */
export interface StandardSchemaTypes<Input = unknown, Output = Input> {
  readonly input: Input;
  readonly output: Output;
}

/** The type a schema accepts: what producers send and what goes on the wire. */
export type InferInput<Schema extends StandardSchemaV1> = NonNullable<Schema["~standard"]["types"]>["input"];

/** The type a schema produces after validation and transformation: what consumers receive. */
export type InferOutput<Schema extends StandardSchemaV1> = NonNullable<Schema["~standard"]["types"]>["output"];

/**
 * Reports whether a value structurally implements Standard Schema v1. Never
 * trust the static type of user-supplied schemas; JavaScript callers and
 * casts can pass anything.
 *
 * @param value - The value to inspect, typically a user-supplied schema.
 * @returns `true` when `value["~standard"]` has `version: 1`, a string `vendor` and a `validate` function.
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

/** The JSON Schema dialects a Standard JSON Schema converter may be asked to produce. */
export type StandardJsonSchemaTarget = "draft-2020-12" | "draft-07" | "openapi-3.0" | (string & {});

/** Options passed to a Standard JSON Schema converter. */
export interface StandardJsonSchemaOptions {
  readonly target: StandardJsonSchemaTarget;
  readonly libraryOptions?: Record<string, unknown> | undefined;
}

/** Converts one side of a schema to JSON Schema. Converters throw when the side cannot be represented. */
export interface StandardJsonSchemaConverter {
  readonly input: (options: StandardJsonSchemaOptions) => Record<string, unknown>;
  readonly output: (options: StandardJsonSchemaOptions) => Record<string, unknown>;
}

/**
 * A Standard Schema that also implements the Standard JSON Schema extension
 * (`~standard.jsonSchema`), as Zod 4.6 does natively. Structural copy of the
 * interface; Holqa never depends on a schema library package.
 */
export interface StandardJsonSchemaV1<Input = unknown, Output = Input> extends StandardSchemaV1<Input, Output> {
  readonly "~standard": StandardSchemaProps<Input, Output> & { readonly jsonSchema: StandardJsonSchemaConverter };
}

/**
 * Reports whether a Standard Schema also exposes a Standard JSON Schema
 * converter with `input` and `output` functions.
 *
 * @param schema - A value already known to implement Standard Schema.
 * @returns `true` when `schema["~standard"].jsonSchema` has `input` and `output` functions.
 */
export function hasStandardJsonSchema<Schema extends StandardSchemaV1>(schema: Schema): schema is Schema & StandardJsonSchemaV1<InferInput<Schema>, InferOutput<Schema>> {
  const props: object = schema["~standard"];
  if (!("jsonSchema" in props) || typeof props.jsonSchema !== "object" || props.jsonSchema === null)
    return false;
  const converter: object = props.jsonSchema;
  return "input" in converter && typeof converter.input === "function"
    && "output" in converter && typeof converter.output === "function";
}