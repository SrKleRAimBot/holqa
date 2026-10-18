import {
  apiResource,
  application,
  configEntry,
  nonEmptyString
} from "@test/support/descriptors";
import {
  describe,
  expect,
  it
} from "bun:test";

import { createEnvironmentBinding } from "@/index";

describe("createEnvironmentBinding", () => {
  it("validates values, applies defaults and advertises only HTTP APIs", async () => {
    const region = configEntry("REGION", nonEmptyString, { defaultValue: "eu" });
    const token = configEntry("TOKEN", nonEmptyString, { sensitive: true });
    const binding = await createEnvironmentBinding(application([apiResource("api")], [region, token])["~holqa"], { TOKEN: "s3cret" });
    expect(binding.config(region)).toBe("eu");
    expect(binding.config(token)).toBe("s3cret");
    expect(binding.capabilities).toEqual({ "http.api": {} });
    expect(binding.drivers).toEqual({});
  });

  it("reports invalid variables with the schema's message and invalid secrets by name only", async () => {
    const app = application([], [configEntry("REGION", nonEmptyString), configEntry("TOKEN", nonEmptyString, { sensitive: true })])["~holqa"];
    const error = await createEnvironmentBinding(app, { REGION: "", TOKEN: "" }).then(() => undefined, (failure: unknown) => failure as { readonly diagnostics: ReadonlyArray<{ readonly message: string }> });
    expect(error?.diagnostics.map(diagnostic => diagnostic.message)).toEqual([
      "The variable REGION does not satisfy its schema: Expected a non-empty string.",
      "The secret TOKEN does not satisfy its schema."
    ]);
  });
});