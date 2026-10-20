import {
  describe,
  expect,
  it
} from "bun:test";

import {
  createRedactor,
  redactedValue
} from "@/observability/redaction";

describe("createRedactor", () => {
  it("redacts fields with sensitive names at any depth", () => {
    const redactor = createRedactor();
    expect(redactor.object({ user: "ada", password: "hunter2", nested: { "x-api-key": "k", "list": [{ authToken: "t" }] } })).toEqual({
      user: "ada",
      password: redactedValue,
      nested: { "x-api-key": redactedValue, "list": [{ authToken: redactedValue }] }
    });
  });

  it("redacts names ending in token-like words without catching unrelated names", () => {
    const redactor = createRedactor();
    expect(redactor.object({ accessToken: "a", setCookie: "b", tokenCount: 3, maxTokens: 4, signatureAlgorithm: "ed25519", secretName: "x" })).toEqual({ accessToken: redactedValue, setCookie: redactedValue, tokenCount: 3, maxTokens: 4, signatureAlgorithm: "ed25519", secretName: redactedValue });
  });

  it("replaces values nested too deeply", () => {
    let nested: Record<string, unknown> = { leaf: "x" };
    for (let depth = 0; depth < 40; depth += 1)
      nested = { nested };
    expect(JSON.stringify(createRedactor().json(nested as never))).toContain("[TRUNCATED]");
  });

  it("removes known secret values wherever they appear in text", () => {
    const redactor = createRedactor({ values: ["s3cr3t-value"] });
    expect(redactor.text("connecting with s3cr3t-value twice: s3cr3t-value")).toBe(`connecting with ${redactedValue} twice: ${redactedValue}`);
    expect(redactor.json(["s3cr3t-value", 1, null])).toEqual([redactedValue, 1, null]);
  });

  it("replaces the longest secret first and ignores very short ones", () => {
    const redactor = createRedactor({ values: ["abc", "abcd", "token-1234", "token-1234-extended"] });
    expect(redactor.text("token-1234-extended abc")).toBe(`${redactedValue} abc`);
    expect(redactor.text("abcd")).toBe(redactedValue);
  });

  it("accepts secret values added later", () => {
    const redactor = createRedactor();
    expect(redactor.text("value 9f8e7d")).toBe("value 9f8e7d");
    redactor.addValues(["9f8e7d"]);
    expect(redactor.text("value 9f8e7d")).toBe(`value ${redactedValue}`);
  });

  it("redacts telemetry attributes by key and value", () => {
    const redactor = createRedactor({ keys: ["ssn"], values: ["p4ssw0rd"] });
    expect(redactor.attributes({ "user.ssn": "123", "note": "p4ssw0rd!", "tags": ["p4ssw0rd"], "count": 3 })).toEqual({ "user.ssn": redactedValue, "note": `${redactedValue}!`, "tags": [redactedValue], "count": 3 });
  });

  it("does not modify its input", () => {
    const input = { password: "x" };
    createRedactor().object(input);
    expect(input).toEqual({ password: "x" });
  });
});