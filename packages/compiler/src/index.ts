export { CanonicalJsonError, canonicalJsonStringify } from "@/manifest/canonical-json";
export type { CanonicalJsonValue } from "@/manifest/canonical-json";
export { canonicalizeJsonSchema } from "@/schema/canonical-json-schema";
export { checkSchemaCompatibility } from "@/schema/compatibility";
export type {
  ChangeClassification,
  ChangeDirection,
  CheckSchemaCompatibilityOptions,
  ContractRole,
  ContractVersion,
  SchemaChange,
  SchemaChangeKind,
  SchemaCompatibilityReport
} from "@/schema/compatibility";
export { fingerprintSchemaContract, schemaFingerprintPrefix } from "@/schema/fingerprint";
export type { AcceptanceCertainty } from "@/schema/json-schema-acceptance";
export { describeSchemaContract, normalizeSchema } from "@/schema/normalize-schema";
export type {
  DescribedSchemaContract,
  DescribeSchemaContractOptions,
  NormalizedSchema,
  NormalizeSchemaOptions
} from "@/schema/normalize-schema";
export { jsonSchemaDialect, schemaContractFormat } from "@/schema/schema-contract";
export type {
  SchemaContract,
  SchemaContractRecord,
  SchemaFidelity,
  SchemaOutputContract,
  SchemaSource
} from "@/schema/schema-contract";