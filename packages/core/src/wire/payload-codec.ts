import type { JsonValue } from "@/json";

import {
  decodeJsonPayload,
  encodeJsonPayload,
  jsonPayloadMediaType
} from "@/wire/json-payload";

/**
 * Converts between an in-memory value and the bytes that cross an execution
 * boundary. Payloads that are not JSON (binary bodies, files) must use an
 * explicit codec; Holqa never guesses an encoding. Streams are not payloads
 * and need separate transport handling.
 *
 * @typeParam Value - The in-memory value type.
 */
export interface PayloadCodec<Value> {
  /** The media type of the encoded bytes, for example `application/json`. */
  readonly mediaType: string;
  /**
   * Encodes a value.
   *
   * @param value - The value to encode.
   * @returns The encoded bytes.
   * @throws {PayloadError} When the value cannot be encoded.
   */
  readonly encode: (value: Value) => Uint8Array;
  /**
   * Decodes received bytes. The result is untrusted until it is validated.
   *
   * @param data - The received bytes.
   * @returns The decoded value.
   * @throws {PayloadError} When the bytes are malformed.
   */
  readonly decode: (data: Uint8Array) => Value;
}

/** The JSON payload codec: UTF-8 JSON following the rules of `toWirePayload`. */
export const jsonPayloadCodec: PayloadCodec<JsonValue> = Object.freeze({
  mediaType: jsonPayloadMediaType,
  encode: (value: JsonValue) => encodeJsonPayload(value, "JSON payload"),
  decode: (data: Uint8Array) => decodeJsonPayload(data, "JSON payload")
});

/** The binary payload codec: bytes pass through unchanged, copied so later mutation cannot alter them. */
export const bytesPayloadCodec: PayloadCodec<Uint8Array> = Object.freeze({
  mediaType: "application/octet-stream",
  encode: (value: Uint8Array) => value.slice(),
  decode: (data: Uint8Array) => data.slice()
});