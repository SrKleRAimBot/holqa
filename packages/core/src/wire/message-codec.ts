import type { JsonValue } from "@/json";
import type {
  InferInput,
  InferOutput,
  StandardSchemaV1
} from "@/schema/standard-schema";

import { diagnosticCodes } from "@/diagnostics/codes";
import { failWith } from "@/errors/holqa-error";
import { validateInput } from "@/schema/validate-input";
import {
  PayloadError,
  toWirePayload
} from "@/wire/json-payload";
import {
  decodeMessageEnvelope,
  encodeMessageEnvelope,
  messageEnvelopeFormat
} from "@/wire/message-envelope";

/**
 * Converts a producer's value to the exact wire payload and validates that
 * payload with the contract's schema. Validating the transmitted copy, rather
 * than the original value, guarantees that what is sent is what consumers
 * will accept: the same schema runs on both ends against the same JSON data.
 *
 * The schema's output is discarded. The wire always carries the input form,
 * so a schema that transforms a string into a `Date` still sends the string.
 *
 * @param schema - The contract's schema.
 * @param value - The producer's value, typed as the schema's input.
 * @param subject - What is being sent, used in error messages.
 * @returns The validated wire payload.
 * @throws {PayloadError} `HOLQA_PAYLOAD_NOT_SERIALIZABLE` when the value has no JSON form.
 * @throws {InputValidationError} `HOLQA_INPUT_INVALID` when the payload fails the schema.
 */
export async function prepareWirePayload<Schema extends StandardSchemaV1>(schema: Schema, value: InferInput<Schema>, subject: string): Promise<JsonValue> {
  const payload = toWirePayload(value, subject);
  await validateInput(schema, payload, subject);
  return payload;
}

/** Settings for {@link createMessageCodec}. */
export interface MessageCodecOptions {
  /** The contract version written into every envelope. A positive integer. */
  readonly schemaVersion: number;
  /** What the codec encodes, for example `message for queue "orders"`. */
  readonly subject: string;
  /**
   * Older schema versions the consumer also accepts. `schemaVersion` itself is always accepted.
   * List older versions only when the current schema still accepts their
   * messages; the compatibility checker can check that, within the limits
   * described in the schema contracts reference.
   */
  readonly acceptedVersions?: readonly number[] | undefined;
  /** The schema contract fingerprint recorded in every envelope, when known. */
  readonly fingerprint?: string | undefined;
}

/** A decoded, validated message and the version metadata it travelled with. */
export interface DecodedMessage<Output> {
  /** The schema's output: validated and possibly transformed. */
  readonly message: Output;
  /** The schema version the producer used. */
  readonly schemaVersion: number;
  /** The producer's contract fingerprint, when it recorded one. */
  readonly fingerprint?: string;
  /** The raw wire payload, before validation. */
  readonly payload: JsonValue;
}

/**
 * Encodes messages on the producer side and decodes them on the consumer side
 * with one schema, so both ends agree on the contract.
 *
 * @typeParam Schema - The schema both ends validate with.
 */
export interface MessageCodec<Schema extends StandardSchemaV1> {
  readonly schema: Schema;
  readonly schemaVersion: number;
  /**
   * Validates a message and encodes it in a versioned envelope.
   *
   * @param message - The message, typed as the schema's input.
   * @returns The envelope bytes.
   * @throws {PayloadError} `HOLQA_PAYLOAD_NOT_SERIALIZABLE`.
   * @throws {InputValidationError} `HOLQA_INPUT_INVALID`.
   */
  readonly encode: (message: InferInput<Schema>) => Promise<Uint8Array>;
  /**
   * Decodes an envelope, checks its schema version and validates the payload.
   *
   * @param data - The received bytes or text.
   * @returns The schema's output and the envelope metadata.
   * @throws {PayloadError} `HOLQA_PAYLOAD_MALFORMED` or `HOLQA_PAYLOAD_VERSION_UNSUPPORTED`.
   * @throws {InputValidationError} `HOLQA_INPUT_INVALID`.
   */
  readonly decode: (data: Uint8Array | string) => Promise<DecodedMessage<InferOutput<Schema>>>;
}

/**
 * Creates a {@link MessageCodec} for one schema and schema version.
 *
 * @param schema - The message schema; any Standard Schema.
 * @param options - The schema version, the subject and the accepted versions.
 * @returns A frozen codec bound to `schema` and `options`.
 * @throws {HolqaError} `HOLQA_SCHEMA_VERSION_INVALID` when a version is not a positive integer.
 *
 * @example
 * ```ts
 * const codec = createMessageCodec(orderPlaced, { schemaVersion: 2, subject: "message for queue \"orders\"" });
 * const bytes = await codec.encode({ orderId: "o_1", placedAt: "2026-10-18T09:00:00Z" });
 * const { message } = await codec.decode(bytes); // the schema's output, for example with a Date
 * ```
 */
export function createMessageCodec<Schema extends StandardSchemaV1>(schema: Schema, options: MessageCodecOptions): MessageCodec<Schema> {
  const { schemaVersion, subject, fingerprint } = options;
  const accepted = options.acceptedVersions ?? [schemaVersion];
  for (const version of [schemaVersion, ...accepted]) {
    if (!Number.isSafeInteger(version) || version < 1)
      failWith(diagnosticCodes.schemaVersionInvalid, `Schema version ${String(version)} for ${subject} must be a positive integer.`);
  }
  const acceptedSet: ReadonlySet<number> = new Set([schemaVersion, ...accepted]);

  return Object.freeze({
    schema,
    schemaVersion,
    encode: async (message: InferInput<Schema>) => {
      const payload = await prepareWirePayload(schema, message, subject);
      return encodeMessageEnvelope({ format: messageEnvelopeFormat, schemaVersion, ...(fingerprint === undefined ? {} : { fingerprint }), payload }, subject);
    },
    decode: async (data: Uint8Array | string) => {
      const envelope = decodeMessageEnvelope(data, subject);
      if (!acceptedSet.has(envelope.schemaVersion)) {
        throw new PayloadError(
          diagnosticCodes.payloadVersionUnsupported,
          subject,
          "$.schemaVersion",
          `schema version ${envelope.schemaVersion} is not accepted (accepted: ${[...acceptedSet].join(", ")}).`,
          "Deploy a consumer that accepts this version, or migrate the message to an accepted version."
        );
      }
      const message = await validateInput(schema, envelope.payload, subject);
      return Object.freeze({
        message,
        schemaVersion: envelope.schemaVersion,
        ...(envelope.fingerprint === undefined ? {} : { fingerprint: envelope.fingerprint }),
        payload: envelope.payload
      });
    }
  });
}