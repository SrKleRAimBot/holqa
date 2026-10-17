// Compile-time checks for declarations. They catch mistakes in literal
// identifiers while the code is being written; the same rules are enforced
// again at run time, because types are erased and identifiers may be computed.

/**
 * A type that no ordinary value satisfies. When a check fails, a parameter is
 * intersected with this type, so TypeScript reports the missing
 * `~holqaTypeError` property together with the message.
 *
 * @typeParam Message - The human-readable problem description.
 */
export interface HolqaTypeError<Message extends string> {
  readonly "~holqaTypeError": Message;
}

/** Lowercase ASCII letters. */
type Letter = "a" | "b" | "c" | "d" | "e" | "f" | "g" | "h" | "i" | "j" | "k" | "l" | "m" | "n" | "o" | "p" | "q" | "r" | "s" | "t" | "u" | "v" | "w" | "x" | "y" | "z";

/** ASCII digits. */
type Digit = "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9";

/** Characters that separate identifier segments. */
type Separator = "-" | ".";

/** Reports whether every character of `Text` may appear in an identifier. */
type OnlyIdentifierCharacters<Text extends string> = Text extends ""
  ? true
  : Text extends `${infer Character}${infer Rest}`
    ? Character extends Letter | Digit | Separator ? OnlyIdentifierCharacters<Rest> : false
    : false;

/** Reports whether `Text` has more than `Limit` characters. */
type LongerThan<Text extends string, Limit extends number, Counted extends unknown[] = []> = Counted["length"] extends Limit
  ? Text extends "" ? false : true
  : Text extends `${string}${infer Rest}` ? LongerThan<Rest, Limit, [...Counted, unknown]> : false;

/**
 * `true` for a plain string literal such as `"orders"`; `false` for `string`
 * and for template literal patterns such as `` `${string}-orders` ``, whose
 * full text is only known at run time. A record keyed by a pattern is an index
 * signature, which `{}` satisfies; a record keyed by a literal is not.
 */
type IsPlainLiteral<Text extends string> = {} extends Record<Text, 1> ? false : true;

/**
 * Describes why a literal identifier violates the resource identifier grammar
 * (`^[a-z][a-z0-9]*(?:[-.][a-z0-9]+)*$`, at most 63 characters), or `never`
 * when it is valid or not fully known at compile time (`string` or a template
 * literal pattern). Distributes over unions.
 *
 * @typeParam Id - The identifier type.
 */
export type ResourceIdProblem<Id extends string> = Id extends unknown ? IsPlainLiteral<Id> extends false ? never : LiteralIdProblem<Id> : never;

/** The grammar violation of a plain string literal, or `never`. */
type LiteralIdProblem<Id extends string> = Id extends ""
  ? "it must not be empty"
  : Id extends `${Letter}${string}`
    ? OnlyIdentifierCharacters<Id> extends false
      ? "it may only contain lowercase letters, digits, \"-\" and \".\""
      : Id extends `${string}${Separator}`
        ? "it must not end with \"-\" or \".\""
        : Id extends `${string}${Separator}${Separator}${string}`
          ? "separators must not be adjacent"
          : LongerThan<Id, 63> extends true ? "it must be at most 63 characters long" : never
    : "it must start with a lowercase letter";

/** One message per invalid member of an identifier union. */
type ResourceIdMessages<Id extends string> = Id extends unknown
  ? [ResourceIdProblem<Id>] extends [never] ? never : `Invalid identifier "${Id}": ${ResourceIdProblem<Id>}.`
  : never;

/**
 * Resolves to `unknown` (no constraint) for a valid or non-literal identifier,
 * and to a {@link HolqaTypeError} describing the problem otherwise.
 *
 * @typeParam Id - The identifier type.
 */
export type CheckResourceId<Id extends string> = [ResourceIdMessages<Id>] extends [never]
  ? unknown
  : HolqaTypeError<ResourceIdMessages<Id>>;

/** The literal identifier of a handle (distributing over unions of handles), or `never` for a non-literal identifier. */
type LiteralId<Handle> = Handle extends { readonly id: infer Id extends string }
  ? Id extends unknown ? IsPlainLiteral<Id> extends true ? Id : never : never
  : never;

/** The literal identifiers of the resources stored under `Key`. */
type LiteralIdAt<Resources, Key extends keyof Resources> = LiteralId<Resources[Key]>;

/**
 * The literal identifiers that more than one entry of a resource record
 * declares. Identifiers typed as plain `string` cannot be compared statically
 * and are left to the run-time check.
 *
 * @typeParam Resources - A record of resource handles keyed by alias.
 */
export type DuplicateResourceIds<Resources> = {
  [Key in keyof Resources]: LiteralIdAt<Resources, Key> extends infer Id
    ? Id extends LiteralIdAt<Resources, Exclude<keyof Resources, Key>> ? Id : never
    : never
}[keyof Resources];

/**
 * Resolves to `unknown` when no literal resource identifier is duplicated, and
 * to a {@link HolqaTypeError} naming the duplicates otherwise.
 *
 * @typeParam Resources - A record of resource handles keyed by alias.
 */
export type CheckUniqueResourceIds<Resources> = [DuplicateResourceIds<Resources>] extends [never]
  ? unknown
  : HolqaTypeError<`Resource identifier "${DuplicateResourceIds<Resources> & string}" is declared more than once. Every resource needs its own id.`>;