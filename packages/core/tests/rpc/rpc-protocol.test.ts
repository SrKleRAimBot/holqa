import type { RpcResponseEnvelope } from "@/rpc/rpc-protocol";

import {
  describe,
  expect,
  expectTypeOf,
  it
} from "bun:test";

import {
  rpcInputQueryParameter,
  rpcMountSegment,
  rpcProcedurePath,
  rpcProtocolFormat,
  rpcProtocolVersion,
  rpcVersionHeader
} from "@/rpc/rpc-protocol";

describe("RPC protocol", () => {
  it("pins the wire constants of version 1", () => {
    expect(rpcProtocolFormat).toBe("holqa.rpc/1");
    expect(rpcProtocolVersion).toBe("1");
    expect(rpcVersionHeader).toBe("holqa-rpc-version");
    expect(rpcMountSegment).toBe("rpc");
    expect(rpcInputQueryParameter).toBe("input");
  });

  it("mounts procedures under the API's base path", () => {
    expect(rpcProcedurePath("/api", "orders.get")).toBe("/api/rpc/orders.get");
    expect(rpcProcedurePath("/", "orders.get")).toBe("/rpc/orders.get");
    expect(rpcProcedurePath("/v1/public", "health")).toBe("/v1/public/rpc/health");
  });

  it("discriminates response envelopes by ok", () => {
    /**
     * Narrows an envelope; checked by tsc.
     *
     * @param envelope - A response envelope.
     * @returns The output or the error code.
     */
    const read = (envelope: RpcResponseEnvelope<{ readonly total: number }>): number | string | undefined => envelope.ok ? envelope.output?.total : envelope.error.code;
    expectTypeOf(read).returns.toEqualTypeOf<number | string | undefined>();
    expect(read({ format: rpcProtocolFormat, ok: true, output: { total: 3 } })).toBe(3);
    expect(read({ format: rpcProtocolFormat, ok: false, error: { code: "HOLQA_INPUT_INVALID", message: "Invalid input." } })).toBe("HOLQA_INPUT_INVALID");
  });
});