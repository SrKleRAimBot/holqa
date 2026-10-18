export { compileApplication } from "@/compile/compile-application";
export type {
  CompileApplicationFailure,
  CompileApplicationInput,
  CompileApplicationResult,
  CompileApplicationSuccess
} from "@/compile/compile-application";
export { moduleEvaluationFailure } from "@/diagnostics/module-evaluation";
export { hasErrors, sortDiagnostics } from "@/diagnostics/sort-diagnostics";
export { discoverHandlers } from "@/discovery/discover-handlers";
export type {
  DiscoveredHandler,
  EvaluatedModule,
  HandlerDiscoveryResult
} from "@/discovery/discover-handlers";
export { compileGlob } from "@/discovery/glob";
export type { GlobMatcher } from "@/discovery/glob";
export { portableModulePath } from "@/discovery/module-path";
export { selectHandlerModules } from "@/discovery/select-handler-modules";
export type { HandlerModuleSelection } from "@/discovery/select-handler-modules";
export { buildResourceGraph } from "@/graph/resource-graph";
export type {
  GraphEdge,
  GraphNode,
  GraphRelation,
  ResourceGraph
} from "@/graph/resource-graph";
export { CanonicalJsonError, canonicalJsonStringify } from "@/manifest/canonical-json";
export type { CanonicalJsonValue } from "@/manifest/canonical-json";
export { entrypointsFormat } from "@/manifest/entrypoints";
export type { EntrypointMap, HandlerEntrypoint } from "@/manifest/entrypoints";
export { manifestRuntimes, manifestVersion } from "@/manifest/manifest";
export type {
  Manifest,
  ManifestApplication,
  ManifestConfigEntry,
  ManifestHandler,
  ManifestResource,
  ManifestResourceOf,
  ManifestRuntime,
  ManifestSchema,
  ManifestSchemaReference,
  ManifestSchemaReferences,
  ManifestTrigger,
  ManifestTriggerOf,
  ManifestVersion
} from "@/manifest/manifest";
export { entrypointsJsonSchema, manifestJsonSchema } from "@/manifest/manifest-json-schema";
export {
  fingerprintManifest,
  manifestFingerprintPrefix,
  serializeEntrypoints,
  serializeManifest
} from "@/manifest/serialize-manifest";
export { validateEntrypoints, validateManifest } from "@/manifest/validate-manifest";
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