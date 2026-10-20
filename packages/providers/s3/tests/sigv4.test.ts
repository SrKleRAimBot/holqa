import {
  describe,
  expect,
  it
} from "bun:test";

import {
  amzDate,
  presign,
  sha256Hex,
  signHeaders,
  uriEncode
} from "@/sigv4";

// The examples of the Amazon S3 documentation ("Signature Calculations for
// the Authorization Header" and "Authenticating Requests: Using Query
// Parameters"), with their published signatures.
const credentials = { accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" };
const scope = { region: "us-east-1", service: "s3", date: new Date("2013-05-24T00:00:00Z") };

describe("SigV4", () => {
  it("signs a GET object request exactly as the specification's example", () => {
    const headers = signHeaders({ method: "GET", url: new URL("https://examplebucket.s3.amazonaws.com/test.txt"), headers: { Range: "bytes=0-9" }, payloadHash: sha256Hex("") }, credentials, scope);
    expect(headers.authorization).toBe("AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41");
  });

  it("presigns a GET URL exactly as the specification's example", () => {
    const url = presign({ method: "GET", url: new URL("https://examplebucket.s3.amazonaws.com/test.txt"), headers: {} }, credentials, scope, 86_400);
    expect(url.searchParams.get("X-Amz-Signature")).toBe("aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404");
    expect(url.searchParams.get("X-Amz-Credential")).toBe("AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request");
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("host");
  });

  it("encodes keys byte by byte, keeping slashes in paths only", () => {
    expect(uriEncode("a b/ü~-_.*(", true)).toBe("a%20b/%C3%BC~-_.%2A%28");
    expect(uriEncode("a/b", false)).toBe("a%2Fb");
    expect(amzDate(new Date("2026-10-20T08:09:10.123Z"))).toBe("20261020T080910Z");
  });
});