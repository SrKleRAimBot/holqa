import type { ResourceRecord } from "@/resources/handle";
import type { HolqaTypeError } from "@/types/checks";

import { DeclarationProblems } from "@/internal/declaration";

/** Aliases that more than one group in a tuple declares. */
type OverlappingAliases<Groups extends readonly unknown[], Seen extends PropertyKey = never> = Groups extends readonly [infer Head, ...infer Tail]
  ? string extends keyof Head
    // A widened group (`ResourceRecord`) has unknown aliases; only the run-time check applies.
    ? OverlappingAliases<Tail, Seen>
    : (keyof Head & Seen) | OverlappingAliases<Tail, Seen | keyof Head>
  : never;

/** Flattens an intersection into one object type for readable hovers. */
type Simplify<Type> = { [Key in keyof Type]: Type[Key] } & {};

/** The intersection of every group in a tuple. */
type MergedGroups<Groups extends readonly unknown[]> = Groups extends readonly [infer Head, ...infer Tail] ? Head & MergedGroups<Tail> : {};

/**
 * The record produced by {@link composeResources}: every group's handles, keyed by alias, with their exact types.
 *
 * @typeParam Groups - The tuple of resource records being combined.
 */
export type ComposedResources<Groups extends readonly ResourceRecord[]> = number extends Groups["length"]
  // An array of unknown length (for example a spread `ResourceRecord[]`) has no precise aliases.
  ? ResourceRecord
  : Simplify<MergedGroups<Groups>>;

/**
 * Resolves to `unknown` when no alias appears in two groups, and to a
 * {@link HolqaTypeError} naming the overlapping aliases otherwise.
 *
 * @typeParam Groups - The composed groups.
 */
export type CheckDistinctAliases<Groups extends readonly unknown[]> = [OverlappingAliases<Groups>] extends [never]
  ? unknown
  : HolqaTypeError<`Resource alias "${OverlappingAliases<Groups> & string}" is declared by more than one group.`>;

/**
 * Gives a group of resource declarations a precise type so that a registry can
 * be split across modules. It returns its argument unchanged.
 *
 * @param resources - Resource handles keyed by local alias.
 * @returns The same object.
 */
export function defineResources<const Resources extends ResourceRecord>(resources: Resources): Resources {
  return resources;
}

/**
 * Combines resource groups declared in separate modules into one record for
 * `defineApp`. Unlike object spread, which silently keeps the last of two
 * equal aliases, it rejects aliases declared by more than one group, at
 * compile time for literal keys and at run time for all keys.
 *
 * @param groups - Resource groups, typically created with {@link defineResources}.
 * @returns A new frozen record containing every group's handles.
 * @throws {HolqaError} `HOLQA_DECLARATION_INVALID` when two groups declare the same alias.
 */
export function composeResources<const Groups extends readonly ResourceRecord[]>(...groups: Groups & CheckDistinctAliases<Groups>): ComposedResources<Groups> {
  const problems = new DeclarationProblems("composeResources");
  const composed: Record<string, unknown> = {};
  for (const group of groups as readonly ResourceRecord[]) {
    for (const [alias, handle] of Object.entries(group)) {
      if (Object.hasOwn(composed, alias))
        problems.invalid(`the alias "${alias}" is declared by more than one group.`, "Rename one of the aliases; aliases are local names and renaming them never changes a resource's identity.");
      composed[alias] = handle;
    }
  }
  problems.throwIfAny();
  return Object.freeze(composed) as ComposedResources<Groups>;
}