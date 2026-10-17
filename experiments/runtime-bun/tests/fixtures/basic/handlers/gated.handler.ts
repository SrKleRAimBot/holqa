import { resources } from "../infra";
import { latch } from "../latches";
import {
  evaluation,
  version
} from "../state";

/** Waits on a test-controlled latch (in-process strategy only), honouring or ignoring cancellation. */
export default resources.gated.consume({
  id: "gated-consumer",
  concurrency: 2,
  handler: async ({ message, signal }) => {
    const gate = latch(message.key);
    gate.markStarted({ version, evaluation });
    if (message.ignoreAbort) {
      await gate.released;
    } else {
      await Promise.race([gate.released, new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      })]);
    }
    gate.finished = { version, evaluation };
  }
});