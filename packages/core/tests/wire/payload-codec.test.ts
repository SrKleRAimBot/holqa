import {
  describe,
  expect,
  it
} from "bun:test";

import {
  bytesPayloadCodec,
  jsonPayloadCodec
} from "@/wire/payload-codec";

describe("payload codecs", () => {
  it("encode JSON as UTF-8 and reject non-JSON values", () => {
    expect(jsonPayloadCodec.mediaType).toBe("application/json");
    expect(jsonPayloadCodec.decode(jsonPayloadCodec.encode({ a: [1] }))).toEqual({ a: [1] });
    expect(() => jsonPayloadCodec.encode({ a: Number.NaN })).toThrow("HOLQA_PAYLOAD_NOT_SERIALIZABLE");
  });

  it("pass bytes through as an independent copy", () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const encoded = bytesPayloadCodec.encode(bytes);
    bytes[0] = 9;
    expect([...encoded]).toEqual([1, 2, 3]);
    expect(bytesPayloadCodec.decode(encoded)).not.toBe(encoded);
    expect(bytesPayloadCodec.mediaType).toBe("application/octet-stream");
  });
});