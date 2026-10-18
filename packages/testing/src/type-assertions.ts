import type { HolqaTypeError } from "@holqa/sdk";

// Compile-time assertions for tests of Holqa applications and of Holqa itself.
// They have no run-time effect: `tsc --noEmit` reports a failed assertion as a
// type error. Use them where `expectTypeOf` from a test runner is unavailable or
// where an assertion must live in a type alias, for example in a declaration
// file that documents an application's contract.

/**
 * `true` when `Actual` and `Expected` are identical types, including
 * `readonly` modifiers and optionality; `false` otherwise. `any` is only equal to `any`.
 *
 * @typeParam Actual - The type under test.
 * @typeParam Expected - The type it must equal.
 */
export type Equal<Actual, Expected> = (<Probe>() => Probe extends Actual ? 1 : 2) extends (<Probe>() => Probe extends Expected ? 1 : 2) ? true : false;

/**
 * `true` when the two types differ.
 *
 * @typeParam Actual - The type under test.
 * @typeParam Unexpected - The type it must not equal.
 */
export type NotEqual<Actual, Unexpected> = Equal<Actual, Unexpected> extends true ? false : true;

/**
 * Compiles only when its argument is `true`. Write `type _ = Expect<Equal<A, B>>`.
 *
 * @typeParam Assertion - An assertion that must hold.
 */
export type Expect<Assertion extends true> = Assertion;

/**
 * Compiles only when its argument is `false`.
 *
 * @typeParam Assertion - An assertion that must not hold.
 */
export type ExpectFalse<Assertion extends false> = Assertion;

/**
 * `true` when `Type` is `any`, which silently disables checking and is almost always a leak.
 *
 * @typeParam Type - The type under test.
 */
export type IsAny<Type> = 0 extends 1 & Type ? true : false;

/**
 * `true` when `Type` is `never`.
 *
 * @typeParam Type - The type under test.
 */
export type IsNever<Type> = [Type] extends [never] ? true : false;

/**
 * `true` when `Type` is `unknown` (and not `any`).
 *
 * @typeParam Type - The type under test.
 */
export type IsUnknown<Type> = IsAny<Type> extends true ? false : unknown extends Type ? true : false;

/**
 * `true` when `Type` is assignable to `Target`, without distributing over unions.
 *
 * @typeParam Type - The type under test.
 * @typeParam Target - The type it must be assignable to.
 */
export type Extends<Type, Target> = [Type] extends [Target] ? true : false;

/**
 * `true` when a function accepts `Argument` as its first parameter, for
 * example whether `typeof resources.orders.send` accepts a message shape.
 * Excess-property checks apply only to object literals at call sites, so an
 * argument type with extra properties is still accepted here.
 *
 * @typeParam Function - The function type, such as a handle operation.
 * @typeParam Argument - The candidate first argument.
 */
export type Accepts<Function extends (...args: never[]) => unknown, Argument> = Extends<Argument, Parameters<Function>[0]>;

/**
 * The message of a compile-time check that the Holqa SDK reported, such as
 * `CheckResourceId<"Orders">`, or `never` when the check passed.
 *
 * @typeParam Check - The result of an SDK check type.
 */
export type TypeErrorMessage<Check> = Check extends HolqaTypeError<infer Message> ? Message : never;

/**
 * `true` when an SDK check type reported a problem.
 *
 * @typeParam Check - The result of an SDK check type.
 */
export type HasTypeError<Check> = IsNever<TypeErrorMessage<Check>> extends true ? false : true;

/**
 * Asserts at compile time that a value has exactly type `Expected`, then does nothing at run time.
 *
 * @param value - The value whose inferred type is checked.
 *
 * @example
 * ```ts
 * assertType<"order-processing">(resources.orders.id);
 * ```
 */
export function assertType<Expected>(value: Expected): void {
  void value;
}