import {
  describe,
  expect,
  it
} from "bun:test";

import { diagnosticCodes } from "@/diagnostics/codes";
import {
  createDiagnostic,
  formatDiagnostic
} from "@/diagnostics/diagnostic";

describe("createDiagnostic", () => {
  it("omits optional fields that were not provided", () => {
    const diagnostic = createDiagnostic({
      code: diagnosticCodes.resourceIdInvalid,
      severity: "error",
      message: "Invalid."
    });
    expect(Object.keys(diagnostic)).toEqual(["code", "severity", "message"]);
    expect(Object.isFrozen(diagnostic)).toBe(true);
  });

  it("rejects unknown diagnostic codes at compile time", () => {
    createDiagnostic({
      // @ts-expect-error Only registered `HOLQA_*` codes are accepted.
      code: "HOLQA_DOES_NOT_EXIST",
      severity: "error",
      message: "Invalid."
    });
  });
});

describe("formatDiagnostic", () => {
  it("formats a diagnostic without location or hint", () => {
    const text = formatDiagnostic(createDiagnostic({
      code: diagnosticCodes.cliUnknownCommand,
      severity: "error",
      message: "Unknown command \"foo\"."
    }));
    expect(text).toBe("error HOLQA_CLI_UNKNOWN_COMMAND: Unknown command \"foo\".");
  });

  it("includes the most specific location available and the hint", () => {
    const base = {
      code: diagnosticCodes.resourceIdInvalid,
      severity: "warning",
      message: "Check this."
    } as const;

    expect(formatDiagnostic(createDiagnostic({ ...base, location: { file: "infra.ts" } })))
      .toBe("infra.ts warning HOLQA_RESOURCE_ID_INVALID: Check this.");
    expect(formatDiagnostic(createDiagnostic({ ...base, location: { file: "infra.ts", line: 3 } })))
      .toBe("infra.ts:3 warning HOLQA_RESOURCE_ID_INVALID: Check this.");
    expect(formatDiagnostic(createDiagnostic({ ...base, location: { file: "infra.ts", line: 3, column: 7 }, hint: "Rename it." })))
      .toBe("infra.ts:3:7 warning HOLQA_RESOURCE_ID_INVALID: Check this.\n  hint: Rename it.");
  });
});

describe("diagnostic details", () => {
  it("are copied and frozen at every level", () => {
    const details = { issues: [{ path: "a" }] };
    const diagnostic = createDiagnostic({ code: diagnosticCodes.inputInvalid, severity: "error", message: "Invalid.", details });
    details.issues[0]!.path = "changed";
    expect(diagnostic.details).toEqual({ issues: [{ path: "a" }] });
    expect(Object.isFrozen(diagnostic.details)).toBe(true);
    expect(Object.isFrozen((diagnostic.details as { issues: readonly object[] }).issues[0])).toBe(true);
  });

  it("are omitted when absent", () => {
    expect("details" in createDiagnostic({ code: diagnosticCodes.inputInvalid, severity: "error", message: "Invalid." })).toBe(false);
  });
});