import {
  describe,
  expect,
  it
} from "bun:test";

import { diagnosticCodes } from "@/diagnostics/codes";

describe("diagnosticCodes", () => {
  it("pins every registered code; codes are never renamed, removed or reused", () => {
    expect(diagnosticCodes).toEqual({
      resourceIdInvalid: "HOLQA_RESOURCE_ID_INVALID",
      cliUnknownCommand: "HOLQA_CLI_UNKNOWN_COMMAND",
      cliNotImplemented: "HOLQA_CLI_NOT_IMPLEMENTED",
      manifestNotSerializable: "HOLQA_MANIFEST_NOT_SERIALIZABLE",
      resourceIdDuplicate: "HOLQA_RESOURCE_ID_DUPLICATE",
      declarationInvalid: "HOLQA_DECLARATION_INVALID",
      inputInvalid: "HOLQA_INPUT_INVALID",
      runtimeNotBound: "HOLQA_RUNTIME_NOT_BOUND",
      runtimeAlreadyBound: "HOLQA_RUNTIME_ALREADY_BOUND",
      bindingCapabilityUnsupported: "HOLQA_BINDING_CAPABILITY_UNSUPPORTED",
      schemaUnsupported: "HOLQA_SCHEMA_UNSUPPORTED",
      schemaFidelityUnverified: "HOLQA_SCHEMA_FIDELITY_UNVERIFIED",
      schemaRuntimeOnly: "HOLQA_SCHEMA_RUNTIME_ONLY",
      schemaChangeBreaking: "HOLQA_SCHEMA_CHANGE_BREAKING",
      schemaChangePotentiallyBreaking: "HOLQA_SCHEMA_CHANGE_POTENTIALLY_BREAKING",
      schemaChangeUnverifiable: "HOLQA_SCHEMA_CHANGE_UNVERIFIABLE",
      schemaMigrationRequired: "HOLQA_SCHEMA_MIGRATION_REQUIRED",
      schemaVersionInvalid: "HOLQA_SCHEMA_VERSION_INVALID",
      payloadNotSerializable: "HOLQA_PAYLOAD_NOT_SERIALIZABLE",
      payloadMalformed: "HOLQA_PAYLOAD_MALFORMED",
      payloadVersionUnsupported: "HOLQA_PAYLOAD_VERSION_UNSUPPORTED"
    });
  });
});