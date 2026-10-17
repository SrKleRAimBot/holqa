import { z } from "zod";

import {
  config,
  resources
} from "@/infra";

/**
 * Computes the hex HMAC-SHA256 of a payload with the Web Crypto API, which
 * works on any standards-compliant runtime.
 *
 * @param secret - The shared webhook secret.
 * @param payload - The signed text.
 * @returns The lowercase hex signature.
 */
async function sign(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)));
  return [...signature].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * `POST /api/webhooks/payments`: verifies a provider-neutral signed payment
 * notification and forwards it to the `payment-events` queue. The webhook
 * secret is read inside the handler, never at module top level, so that the
 * module can be analyzed without configuration.
 */
export default resources.api.route({
  id: "payments.webhook",
  method: "POST",
  path: "/webhooks/payments",
  body: z.object({ payload: z.string(), signature: z.string() }),
  responses: {
    202: z.object({ accepted: z.literal(true) }),
    401: z.object({ message: z.string() }),
    422: z.object({ message: z.string() })
  },
  handler: async ({ body, reply }) => {
    if (await sign(config.PAYMENT_WEBHOOK_SECRET, body.payload) !== body.signature)
      return reply(401, { message: "Invalid signature." });
    let event: unknown;
    try {
      event = JSON.parse(body.payload);
    } catch {
      return reply(422, { message: "The payload is not JSON." });
    }
    // The payload is untrusted; `send` validates it against the queue schema and rejects malformed events.
    await resources.payments.send(event as never);
    return reply(202, { accepted: true });
  }
});

export { sign };