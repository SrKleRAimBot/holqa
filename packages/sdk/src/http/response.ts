import type {
  JsonObject,
  JsonValue,
  StandardSchemaV1
} from "@holqa/core";

import {
  createDiagnostic,
  diagnosticCodes,
  diagnosticsOf,
  HolqaError,
  jsonPayloadMediaType,
  toWirePayload,
  validateInput
} from "@holqa/core";

/** Statuses whose responses must not have a body. */
const nullBodyStatuses: ReadonlySet<number> = new Set([101, 204, 205, 304]);

/**
 * Builds a `HOLQA_RESPONSE_INVALID` error: the handler, not the caller, broke
 * the contract, so the runtime answers with a server error and logs the details.
 *
 * @param message - What is wrong with the response.
 * @param cause - The underlying validation or encoding error, if any.
 * @param details - Structured data for logs, such as the status.
 * @returns The error to throw.
 */
export function responseInvalid(message: string, cause?: unknown, details?: JsonObject): HolqaError {
  const causes = diagnosticsOf(cause);
  return new HolqaError(createDiagnostic({
    code: diagnosticCodes.responseInvalid,
    severity: "error",
    message,
    details: { ...details, ...causes.length === 0 ? {} : { causes: causes.map(diagnostic => ({ code: diagnostic.code, message: diagnostic.message, ...diagnostic.details === undefined ? {} : { details: diagnostic.details } })) } }
  }), cause === undefined ? undefined : { cause });
}

/**
 * Validates a response value against its schema and returns the JSON copy of
 * the validated **output** that goes on the wire. Responses (route bodies and
 * procedure outputs) are serialized after validation, which is also how the
 * compiler describes them, so the schema's output must have a JSON form.
 *
 * @param schema - The response contract.
 * @param value - The value in the schema's input form, as the handler returned it.
 * @param subject - What is encoded, for messages.
 * @returns The JSON copy of the validated output, or `undefined` when the output is `undefined`.
 * @throws {HolqaError} `HOLQA_INPUT_INVALID` when the schema rejects the value, or `HOLQA_PAYLOAD_NOT_SERIALIZABLE` when its output has no JSON form.
 */
export async function encodeContractValue(schema: StandardSchemaV1, value: unknown, subject: string): Promise<JsonValue | undefined> {
  const output: unknown = await validateInput(schema, value, subject);
  return output === undefined ? undefined : toWirePayload(output, subject);
}

/**
 * Builds a JSON response from a value that already passed its contract.
 *
 * @param status - The HTTP status.
 * @param payload - The validated JSON payload (or an envelope of validated payloads), or `undefined` for no body.
 * @param headers - Extra response headers.
 * @param subject - What is sent, for messages.
 * @returns A `Response` with a JSON body and `content-type`, or with no body.
 * @throws {HolqaError} `HOLQA_RESPONSE_INVALID` when a status that forbids a body would carry one.
 */
export function jsonResponse(status: number, payload: JsonValue | object | undefined, headers: Readonly<Record<string, string>> | undefined, subject: string): Response {
  const responseHeaders = new Headers(headers);
  if (payload === undefined)
    return new Response(null, { status, headers: responseHeaders });
  if (nullBodyStatuses.has(status))
    throw responseInvalid(`The ${subject} has a body, but status ${status} must not have one.`, undefined, { status });
  if (!responseHeaders.has("content-type"))
    responseHeaders.set("content-type", `${jsonPayloadMediaType}; charset=utf-8`);
  return new Response(JSON.stringify(payload), { status, headers: responseHeaders });
}