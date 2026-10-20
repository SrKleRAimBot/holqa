import type { Recording } from "@/index";

import { diagnosticsOf } from "@holqa/core";
import app, { handlers } from "@test/fixtures/orders";
import {
  describe,
  expect,
  it
} from "bun:test";

import {
  createTestApp,
  recordingFormat
} from "@/index";

/**
 * Runs the order pipeline for one order and returns the test app.
 *
 * @param orderId - The order to place.
 * @returns The test app, after the order and everything it caused ran.
 */
async function placed(orderId: string): Promise<Awaited<ReturnType<typeof createTestApp>>> {
  const test = await createTestApp({ app, handlers });
  await test.send("orders", { orderId });
  await test.drain();
  return test;
}

describe("recording, replay and causal chains", () => {
  it("records what each handler received, with its lineage, as JSON data", async () => {
    await using test = await placed("o-1");
    const recording = test.recording();
    expect(recording).toMatchObject({ format: recordingFormat, application: "orders", sanitized: true });
    const [consume, written] = recording.invocations;
    expect(consume).toMatchObject({ handlerId: "orders.process", triggerKind: "queue.message", input: { orderId: "o-1" }, metadata: { attempt: 1 }, lineage: { depth: 0 }, replayable: true });
    expect(written).toMatchObject({ handlerId: "receipts.written", triggerKind: "bucket.object-created", lineage: { depth: 1, causationId: consume!.invocationId, rootId: consume!.lineage.rootId }, replayable: true });
    // The recording survives a round trip through a file.
    expect(JSON.parse(JSON.stringify(recording))).toEqual(JSON.parse(JSON.stringify(recording)));
  });

  it("marks HTTP invocations as not replayable", async () => {
    await using test = await createTestApp({ app, handlers });
    await test.fetch("/api/orders", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ orderId: "o-2" }) });
    await test.drain();
    const [request] = test.recording({ handlerId: "orders.place" }).invocations;
    expect(request).toMatchObject({ handlerId: "orders.place", replayable: false });
    await expect(test.replay(request!)).rejects.toThrow("cannot be replayed");
  });

  it("replays a stored recording's roots in a fresh application, reproducing the chain they cause", async () => {
    let stored: Recording;
    {
      await using original = await placed("o-3");
      stored = JSON.parse(JSON.stringify(original.recording())) as Recording;
    }
    await using replayed = await createTestApp({ app, handlers });
    const outcomes = await replayed.replay(stored);
    expect(outcomes.map(outcome => [outcome.handlerId, outcome.ok])).toEqual([["orders.process", true]]);
    expect(await replayed.read("receipts", "receipts/o-3.json")).toContain("\"orderId\":\"o-3\"");
    expect(replayed.invocations().map(record => record.handlerId)).toEqual(["orders.process", "receipts.written"]);
  });

  it("replays every recorded invocation individually when asked, and injected failures still apply", async () => {
    let recording: Recording;
    {
      // An application is bound to one running test app at a time.
      await using original = await placed("o-4");
      recording = original.recording();
    }
    await using replayed = await createTestApp({ app, handlers });
    replayed.failNext("orders.process");
    const outcomes = await replayed.replay(recording, { rootsOnly: false, flush: false });
    expect(outcomes.map(outcome => [outcome.handlerId, outcome.ok])).toEqual([["orders.process", false], ["receipts.written", true]]);
  });

  it("steps through a root operation's causal chain in causal order", async () => {
    await using test = await placed("o-5");
    const [root] = test.invocations({ handlerId: "orders.process" });
    const steps = test.chain(root!.rootId);
    expect(steps.map(step => [step.index, step.record.handlerId, step.causedBy])).toEqual([[0, "orders.process", undefined], [1, "receipts.written", 0]]);
    expect(steps[0]!.input).toEqual({ orderId: "o-5" });
    expect(test.chain("unknown")).toEqual([]);
  });

  it("redacts sensitive fields unless asked not to", async () => {
    await using test = await createTestApp({ app, handlers });
    // The schema rejects the extra field, but the recording keeps what the handler received.
    await test.invoke("orders.process", { orderId: "o-6", password: "hunter2-secret" });
    const [sanitized] = test.recording({ handlerId: "orders.process" }).invocations;
    expect(sanitized!.input).toMatchObject({ orderId: "o-6", password: "[REDACTED]" });
    const [raw] = test.recording({ handlerId: "orders.process", sanitize: false }).invocations;
    expect(raw!.input).toMatchObject({ password: "hunter2-secret" });
  });

  it("rejects malformed recordings with HOLQA_OPERATION_INVALID", async () => {
    await using test = await createTestApp({ app, handlers });
    for (const source of [{ format: "other/1", invocations: [] }, { format: recordingFormat }, { invocationId: 1 }]) {
      let error: unknown;
      try {
        await test.replay(source as never);
      } catch (caught) {
        error = caught;
      }
      expect(diagnosticsOf(error).map(diagnostic => diagnostic.code)).toEqual(["HOLQA_OPERATION_INVALID"]);
    }
  });
});