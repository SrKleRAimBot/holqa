import type {
  JsonObject,
  JsonValue
} from "@/json";
import type {
  TelemetryAttributes,
  TelemetryAttributeValue
} from "@/observability/telemetry";

/** What replaces a redacted value. */
export const redactedValue = "[REDACTED]";

/**
 * Field names whose values are always redacted, compared after lowercasing
 * and removing everything but letters and digits, anywhere in the name:
 * `dbPassword`, `client_secret_v2` and `credentials` all match.
 */
export const defaultSensitiveKeys: readonly string[] = Object.freeze([
  "password",
  "passwd",
  "secret",
  "privatekey",
  "credential"
]);

/**
 * Field names whose values are always redacted when the name ends with them:
 * `apiKey`, `x-api-key`, `accessToken` and `set-cookie` match, while
 * `tokenCount`, `maxTokens` and `signatureAlgorithm` do not.
 */
export const defaultSensitiveKeySuffixes: readonly string[] = Object.freeze([
  "token",
  "authorization",
  "cookie",
  "apikey",
  "accesskey",
  "signature"
]);

/**
 * Secret values shorter than this are not searched for inside other text:
 * replacing one- to three-character strings everywhere would destroy logs
 * without protecting anything a guess could not find.
 */
export const minRedactedValueLength = 4;

/** How deep {@link Redactor.json} descends into nested values; deeper values are replaced. */
const maxDepth = 32;

/** Settings of {@link createRedactor}. */
export interface RedactorOptions {
  /** Additional field names to redact, matched anywhere in a name like {@link defaultSensitiveKeys}. */
  readonly keys?: readonly string[];
  /** Exact secret values to remove wherever they appear in text, for example the values of declared secrets. */
  readonly values?: readonly string[];
}

/**
 * Removes sensitive data from structured telemetry before it leaves the
 * process: values of fields with sensitive names, and occurrences of known
 * secret values anywhere in text. It cannot recognize secrets it was not
 * told about, or known secrets that were transformed (encoded, hashed,
 * split); keep such data out of logs.
 */
export interface Redactor {
  /** Returns the text with every known secret value replaced by {@link redactedValue}. */
  readonly text: (value: string) => string;
  /** Returns a copy of a JSON value with sensitive fields and known secret values redacted. */
  readonly json: (value: JsonValue) => JsonValue;
  /** Returns a copy of a JSON object with sensitive fields and known secret values redacted. */
  readonly object: (value: JsonObject) => JsonObject;
  /** Returns a copy of telemetry attributes with sensitive keys and known secret values redacted. */
  readonly attributes: (value: TelemetryAttributes) => TelemetryAttributes;
  /** Reports whether a field name is sensitive. */
  readonly isSensitiveKey: (key: string) => boolean;
  /** Adds secret values to search for, for example once configuration has been read. */
  readonly addValues: (values: readonly string[]) => void;
}

/**
 * Normalizes a field name for comparison: lowercase letters and digits only.
 *
 * @param key - The field name.
 * @returns The normalized name.
 */
function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Creates a redactor for field names and secret values.
 *
 * @param options - Extra sensitive field names and known secret values.
 * @returns A redactor that applies the default and extra field names and the known secret values.
 *
 * @example
 * ```ts
 * const redactor = createRedactor({ values: ["s3cr3t-token"] });
 * redactor.object({ user: "ada", password: "hunter2", note: "used s3cr3t-token" });
 * // { user: "ada", password: "[REDACTED]", note: "used [REDACTED]" }
 * ```
 */
export function createRedactor(options: RedactorOptions = {}): Redactor {
  const keys = [...defaultSensitiveKeys, ...options.keys ?? []].map(normalizeKey).filter(key => key !== "");
  const suffixes = defaultSensitiveKeySuffixes.map(normalizeKey);
  // Longest first, so a secret that contains another secret is replaced whole.
  let secrets: string[] = [];

  /**
   * Adds secret values, ignoring short and duplicate ones.
   *
   * @param values - The candidate values.
   */
  const addValues = (values: readonly string[]): void => {
    const next = new Set(secrets);
    for (const value of values) {
      if (typeof value === "string" && value.length >= minRedactedValueLength)
        next.add(value);
    }
    secrets = [...next].sort((left, right) => right.length - left.length);
  };
  addValues(options.values ?? []);

  /**
   * Reports whether a field name matches a sensitive name.
   *
   * @param key - The field name.
   * @returns `true` when its value must be redacted.
   */
  const isSensitiveKey = (key: string): boolean => {
    const normalized = normalizeKey(key);
    return normalized !== "" && (keys.some(sensitive => normalized.includes(sensitive)) || suffixes.some(suffix => normalized.endsWith(suffix)));
  };

  /**
   * Replaces known secret values in text.
   *
   * @param value - Text that may contain a secret.
   * @returns The text with every known secret replaced.
   */
  const text = (value: string): string => {
    let result = value;
    for (const secret of secrets) {
      if (result.includes(secret))
        result = result.split(secret).join(redactedValue);
    }
    return result;
  };

  /**
   * Redacts a JSON value recursively.
   *
   * @param value - A JSON value that may hold sensitive fields or secrets.
   * @param depth - How deep the value is nested.
   * @returns The redacted copy.
   */
  const json = (value: JsonValue, depth = 0): JsonValue => {
    if (typeof value === "string")
      return text(value);
    if (value === null || typeof value !== "object")
      return value;
    if (depth >= maxDepth)
      return "[TRUNCATED]";
    if (Array.isArray(value))
      return (value as readonly JsonValue[]).map(item => json(item, depth + 1));
    const copy: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value as JsonObject))
      copy[key] = isSensitiveKey(key) ? redactedValue : json(item, depth + 1);
    return copy;
  };

  /**
   * Redacts one attribute value.
   *
   * @param value - A scalar or array attribute value.
   * @returns The value with known secrets replaced in its strings.
   */
  const attributeValue = (value: TelemetryAttributeValue): TelemetryAttributeValue => {
    if (typeof value === "string")
      return text(value);
    if (Array.isArray(value) && value.every(item => typeof item === "string"))
      return value.map(item => text(item as string));
    return value;
  };

  return Object.freeze({
    text,
    json: (value: JsonValue) => json(value),
    object: (value: JsonObject) => json(value) as JsonObject,
    attributes: (value: TelemetryAttributes) => Object.fromEntries(Object.entries(value).map(([key, item]) => [key, isSensitiveKey(key) ? redactedValue : attributeValue(item)])),
    isSensitiveKey,
    addValues
  });
}