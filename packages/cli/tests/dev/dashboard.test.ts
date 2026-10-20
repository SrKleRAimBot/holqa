import type { DashboardSource } from "@/dev/dashboard";

import {
  describe,
  expect,
  it
} from "bun:test";

import {
  isLoopbackHost,
  serveDashboard,
  withoutPayloads
} from "@/dev/dashboard";

/** A dashboard source with fixed data. */
const source: DashboardSource = {
  status: () => ({ hot: true }),
  state: async () => ({ queues: [{ id: "jobs", messages: [{ messageId: "m1", payload: { card: "4111" } }] }] }),
  logs: () => [{ level: "info", message: "hello" }],
  traces: () => [],
  trace: traceId => traceId === "known" ? [{ name: "span" }] : undefined
};

/**
 * Requests a dashboard path.
 *
 * @param path - The path below the dashboard.
 * @param init - Request settings.
 * @returns The response.
 */
async function request(path: string, init?: RequestInit): Promise<Response> {
  return serveDashboard(new Request(`http://127.0.0.1:3000/_holqa/dashboard${path}`, init), source);
}

describe("serveDashboard", () => {
  it("serves the page with a strict content security policy", async () => {
    const response = await request("");
    const policy = response.headers.get("content-security-policy")!;
    const nonce = /'nonce-([a-f0-9]+)'/.exec(policy)?.[1];
    expect(nonce).toBeDefined();
    expect(await response.text()).toContain(`<script nonce="${nonce}">`);
  });

  it("serves state without message payloads", async () => {
    expect(await (await request("/api/state")).json()).toEqual({ queues: [{ id: "jobs", messages: [{ messageId: "m1" }] }] });
  });

  it("serves logs, traces and one trace", async () => {
    expect(await (await request("/api/logs")).json()).toEqual({ entries: [{ level: "info", message: "hello" }] });
    expect(await (await request("/api/traces/known")).json()).toEqual({ spans: [{ name: "span" }] });
    expect((await request("/api/traces/unknown")).status).toBe(404);
    expect((await request("/api/other")).status).toBe(404);
  });

  it("refuses other host names and methods", async () => {
    expect((await request("/api/status", { headers: { host: "example.test:3000" } })).status).toBe(403);
    expect((await request("/api/status", { method: "DELETE" })).status).toBe(405);
  });
});

describe("dashboard helpers", () => {
  it("recognizes loopback host names", () => {
    expect(["127.0.0.1", "localhost", "[::1]", "LOCALHOST"].map(isLoopbackHost)).toEqual([true, true, true, true]);
    expect(["0.0.0.0", "192.168.1.2", "example.test"].map(isLoopbackHost)).toEqual([false, false, false]);
  });

  it("keeps state without queues unchanged apart from an empty queue list", () => {
    expect(withoutPayloads({ application: "app" })).toEqual({ application: "app", queues: [] });
  });
});