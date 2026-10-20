import { diagnosticsOf } from "@holqa/core";
import {
  describe,
  expect,
  it
} from "bun:test";

import { runHttpPipeline } from "@/http/pipeline";

/** Discards a log entry. */
function silent(): void {}

/** An invocation context outside a runtime. */
const context = { invocationId: "inv-1", signal: new AbortController().signal, metadata: {}, log: { debug: silent, info: silent, warn: silent, error: silent } };

describe("runHttpPipeline", () => {
  it("passes request, URL, parameters and identifiers to the terminal step without middleware", async () => {
    const response = await runHttpPipeline({ request: new Request("http://localhost/a?b=1"), params: { id: "7" } }, context, [], async args => Response.json({ path: args.url.pathname, params: args.params, correlationId: args.correlationId, context: args.context }));
    expect(await response.json()).toEqual({ path: "/a", params: { id: "7" }, correlationId: "inv-1", context: {} });
  });

  it("rejects input that is not an HTTP invocation", async () => {
    const error = await runHttpPipeline({ body: 1 }, context, [], async () => new Response()).catch((failure: unknown) => failure);
    expect(diagnosticsOf(error).map(diagnostic => diagnostic.code)).toEqual(["HOLQA_INPUT_INVALID"]);
  });
});