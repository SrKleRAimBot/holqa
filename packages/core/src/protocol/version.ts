/**
 * The property under which every Holqa value carries its descriptor. A string
 * key (like Standard Schema's `~standard`) instead of a `unique symbol` keeps
 * values readable across duplicate copies of `@holqa/core` in one installation.
 */
export const descriptorKey = "~holqa";

/** The descriptor protocol version written by this package. Readers reject other versions. */
export const descriptorProtocol = 1;

/** The literal type of {@link descriptorProtocol}. */
export type DescriptorProtocol = typeof descriptorProtocol;