# Schema interoperability experiment

> **Status:** Disposable M0 experiment — not part of the framework.

## Question

Can Zod schemas, and the schemas of one other library (Valibot), be validated and normalized into portable JSON Schema without tying the core framework to Zod's implementation types?

## Method

| Part | What it does |
| --- | --- |
| `@holqa/experiment-model` (not this package) | Defines the neutral contracts: structural copies of the Standard Schema and Standard JSON Schema interfaces, `validateInput`, and the `SchemaAdapter` interface (`convert(schema, side)` returning JSON Schema plus a list of `runtimeOnly` constraints, or a failure reason). It imports no schema library. |
| `src/zod.ts` | `zodAdapter`. It converts with Zod's built-in `~standard.jsonSchema` and walks `schema._zod.def` structurally (through `unknown` and narrowing, without importing Zod) to find what that converter omits or misrepresents. |
| `src/valibot.ts` | `valibotAdapter`, backed by `@valibot/to-json-schema` with `typeMode` set to the requested side and `errorMode: "throw"`. It walks Valibot's `pipe` arrays to report unconvertible validation actions, which are then excluded through `ignoreActions`. |
| `src/standard-json-schema.ts` | `createStandardJsonSchemaAdapter(vendor)`: a fallback for any library that implements Standard JSON Schema but has no Holqa adapter. It cannot prove fidelity, and its `library` is marked `(unverified)`. |
| `tests/` | A corpus of Zod and Valibot schemas, cross-library comparisons, validation through the neutral `validateInput`, neutrality checks on the built model and SDK, and compile-time inference tests. |

Adapters may import their own schema library: Valibot's converter is an optional peer dependency of this package. The model, SDK and compiler may not import any schema library.

Versions: Zod 4.6.7, Valibot 1.5.0, `@valibot/to-json-schema` 1.8.0, Bun 1.3.13 (arm64).

## Results

All results come from `bun test` (48 passing tests) and one timing script that was run locally and not committed.

### Validation

`validateInput` validates both libraries without knowing which library a schema comes from:

- Defaults are applied and the output type is returned.
- Asynchronous refinements return a `Promise` from `~standard.validate` in both libraries. `validateInput` always awaits, so callers need no special handling.
- Issue paths from both libraries normalize to the same dotted form, for example `lines.0.quantity`, with code `HOLQA_INPUT_INVALID`.

The SDK accepts a hand-written Standard Schema object that uses no library at all.

### Neutrality

- The built `experiments/model/dist` and `experiments/sdk/dist` files contain no import, `require` or type reference to `zod`, `valibot` or `@standard-schema/*`. Comments name Zod as an example; that is allowed.
- `InferInput` and `InferOutput` in the model resolve exactly for:
  - a Zod transform: `string` in, `number` out;
  - Zod and Valibot objects with defaults: optional in the input type, required in the output type;
  - a Valibot transform;
  - a hand-written schema.
- A value that does not implement Standard Schema is rejected at compile time.
- `queue(...).send` accepts the schema's input type.

### Conversion corpus

| Construct | Zod adapter | Valibot adapter |
| --- | --- | --- |
| Objects, enums, arrays, unions, discriminated unions, records, nullable, tuples, ISO datetime, brands | Converted, no runtime-only entries | Converted |
| Defaults | Input: optional with `default`. Output: required, plus `additionalProperties: false` | Output marks the defaulted property optional (`required: []`), which is wrong; reported as runtime-only |
| Recursion | `$ref: "#"` | `$defs` with generated names (`"0"`) that depend on traversal order |
| `.meta({ id })` | Named `$defs` entry | Not tested |
| `.refine()`, `.superRefine()`, object-level refine, async refine | Zod's converter drops them silently; the adapter reports each one with its path, for example `$.lines[*].sku` | `check` makes the converter throw; the adapter reports it as runtime-only and excludes it |
| `.trim()` and `.toLowerCase()` (Zod "overwrite" checks) | Dropped silently by Zod; reported | Not applicable |
| `pipe`, `preprocess`, `coerce`, `catch` | Input describes the first schema; the rest is reported as runtime-only | Validations after a transform are reported |
| Transforms | Input converted; output rejected | Input converted; output rejected unless the pipe ends with a schema |
| Codec (`z.codec`) | Input converted (ISO string); output rejected (Date) | Not applicable |
| `Date`, `bigint`, `custom`, `Map`, `Set`, `promise`, `file` | Rejected with a reason. Zod's own converter would describe `promise(T)` as `T` and `file()` as a binary string; the adapter rejects both | `date`, `bigint` and `custom` rejected |
| `isoDateTime` | Not applicable | Converted to `format: "date-time"`, but Valibot accepts `2026-10-17T10:00` and rejects `2026-10-17T10:00:00Z`; the mismatch is reported |
| An unknown check kind | Treated as runtime-only. The allow-list caught `number_format` (from `.int()`) during development before it was added | Unknown validation actions are runtime-only |

### Same logical schema, different JSON Schema

For the same order message (a UUID, an integer of at least 1, and a defaulted enum):

| Aspect | Zod | Valibot |
| --- | --- | --- |
| Integer | `type: "integer"` with `minimum: 1` and `maximum: 9007199254740991` | `type: "integer"` with `minimum: 1` |
| UUID | `format: "uuid"` plus a long `pattern` | `format: "uuid"` only |
| `$schema`, key order | Written first | Written last |

The adapters remove `$schema`, and canonical JSON fixes key order. The remaining differences in keywords are real.

### Timing

Measured on an order schema with a nested object, an array of line items, one refinement, a defaulted enum and an ISO timestamp, after warm-up:

| Operation | Time per call |
| --- | --- |
| Zod adapter `convert` (input side) | 38–58 µs (two runs) |
| Zod `~standard.jsonSchema.input` alone | 32–34 µs |
| Valibot adapter `convert` (input side) | 10–14 µs |
| Zod `~standard.validate` | 2.2 µs |
| Valibot `~standard.validate` | 0.8 µs |

Conversion is a compile-time cost. Even a few hundred schemas cost milliseconds, and the structural walk adds little to Zod's own conversion.

## Findings

1. **The core does not need Zod's types (confirmed).** Structural Standard Schema types drive inference, validation and the adapter contract. Library types reach the SDK only through generics.
2. **Standard Schema covers validation and inference; Standard JSON Schema covers conversion. Neither guarantees that nothing is silently approximated (fundamental limitation).**
   - Zod 4.6's converter drops refinements and value rewriting, and misdescribes `promise` and `file`, all without an error, even with `unrepresentable: "throw"`.
   - Valibot's converter marks defaulted output properties optional and maps `isoDateTime` to a format with different semantics.
   - Only a library-specific adapter that inspects the library's internal representation can report these. Library-specific adapters are therefore required for the "never silently approximated" rule; the generic Standard JSON Schema path can only be trusted as "unverified".
3. **Adapters depend on library internals (`_zod.def`, Valibot `pipe`).** These are not stable public APIs, so every library upgrade can change adapter behavior. The allow-list design (unknown checks become runtime-only; unknown Zod types fail) makes such changes fail visibly rather than silently. Adapters still need a test corpus that runs against each supported library version.
4. **JSON Schema output depends on the library and its version (fundamental limitation for fingerprints).**
   - The same logical contract produces different JSON Schema in Zod and Valibot.
   - Valibot's generated `$defs` names depend on traversal order.
   - Zod's patterns and integer bounds can change between releases.

   A fingerprint over raw converter output therefore changes when a team switches libraries, and possibly when it upgrades one, even though the wire contract is unchanged. Mitigations, which belong to the compiler experiment:
   - Canonicalize JSON Schema before fingerprinting: drop `$schema`, normalize `$defs` names, and decide whether `required` is a set.
   - Record `library` in the manifest so fingerprint changes can be explained.
   - Treat fingerprints as "contract possibly changed" signals, not proof of a breaking change.
5. **Declaration order is semantically irrelevant but visible.** `required` follows property declaration order, so reordering properties changes canonical JSON, even though `required` has set semantics. The compiler must sort set-like keywords before fingerprinting.
6. **Input and output sides must stay separate in the manifest.** With defaults, transforms, codecs and Zod's `additionalProperties: false` on the output side, the two sides routinely differ. A transform's output side is often not representable at all, which matters for anything that must describe what consumers receive.
7. **`runtimeOnly` is the useful middle ground.** Rejecting every refinement would reject idiomatic schemas such as `.refine()`; ignoring them would break the honesty rule. Recording them, with paths, in the manifest and as a warning keeps the contract honest and the schema usable.

## Recommendation for ADR 0006

Accept ADR 0006 with these amendments (adopted as [ADR 0016](../../docs/architecture/decisions/0016-schema-adapters-and-conversion-fidelity.md), which supersedes 0006):

- Core generics use structural Standard Schema types. Validation goes through `~standard.validate` and is always awaited.
- Normalization goes through per-library adapters that implement a core-owned `SchemaAdapter` contract. Standard JSON Schema is the conversion engine, not the fidelity guarantee.
- A schema whose vendor has no adapter but implements Standard JSON Schema is accepted with `HOLQA_SCHEMA_FIDELITY_UNVERIFIED` (a warning). A schema with neither is rejected with `HOLQA_SCHEMA_UNSUPPORTED`.
- The manifest stores input and output JSON Schema separately, together with the runtime-only constraint list and the adapter's `library` identifier.
- Fingerprints are computed over a Holqa-canonicalized JSON Schema and are documented as library-sensitive.

## Desired model changes (not made here)

- `SchemaConversion` could carry an explicit `fidelity: "verified" | "unverified"` field instead of encoding it in `SchemaAdapter.library`.
- `runtimeOnly` entries are strings. Structured entries (`{ path, kind, detail }`) would let the compiler emit one diagnostic per entry with stable fields.

## What is disposable

Everything in this directory. A future `packages/integrations/zod` and `packages/integrations/valibot` should reuse the findings, the allow-list approach and the test corpus, not the code as is.
