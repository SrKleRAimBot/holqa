import {
  apiResource,
  application,
  latch,
  routeHandler
} from "@test/support/descriptors";
import {
  describe,
  expect,
  it
} from "bun:test";

import {
  createRuntime,
  serve,
  silentSink
} from "@/index";

describe("serve", () => {
  it("starts the runtime, serves requests over a loopback port and stops gracefully", async () => {
    const gate = latch();
    const entered = latch();
    const runtime = createRuntime({
      app: application([apiResource("api")]),
      env: {},
      log: silentSink,
      handlers: [
        routeHandler("hello", "api", "GET", "/hello/:name", ({ params: { name } }) => Response.json({ hello: name })),
        routeHandler("slow", "api", "GET", "/slow", async () => {
          entered.release();
          await gate.promise;
          return new Response("finished");
        })
      ]
    });
    const server = await serve(runtime, { port: 0 });
    expect(runtime.state).toBe("running");
    expect(server.url.hostname).toBe("127.0.0.1");
    const hello = await fetch(new URL("/api/hello/ada", server.url));
    expect([hello.status, await hello.json()]).toEqual([200, { hello: "ada" }]);

    const slow = fetch(new URL("/api/slow", server.url));
    await entered.promise;
    const stopped = server.stop({ graceMs: 2_000 });
    gate.release();
    expect(await (await slow).text()).toBe("finished");
    await stopped;
    expect(runtime.state).toBe("stopped");
    await expect(fetch(new URL("/api/hello/ada", server.url))).rejects.toThrow();
  });

  it("stops the runtime again when the port cannot be bound", async () => {
    const options = { app: application([apiResource("api")]), env: {}, log: silentSink, handlers: [] };
    const first = await serve(createRuntime(options), { port: 0 });
    const second = createRuntime({ ...options, app: application([apiResource("api")]) });
    await expect(serve(second, { port: first.port })).rejects.toThrow();
    expect(second.state).toBe("stopped");
    await first.stop();
  });

  it("answers liveness and readiness probes before routing", async () => {
    const gate = latch();
    const entered = latch();
    const runtime = createRuntime({
      app: application([apiResource("api")]),
      env: {},
      log: silentSink,
      handlers: [routeHandler("slow", "api", "GET", "/slow", async () => {
        entered.release();
        await gate.promise;
        return new Response("finished");
      })]
    });
    const server = await serve(runtime, { port: 0, health: { livePath: "/.holqa/live", readyPath: "/.holqa/ready" } });
    const live = await fetch(new URL("/.holqa/live", server.url));
    expect([live.status, live.headers.get("cache-control"), await live.json()]).toEqual([200, "no-store", { status: "live", state: "running" }]);
    const ready = await fetch(new URL("/.holqa/ready", server.url));
    expect(ready.status).toBe(200);
    expect(await ready.json()).toMatchObject({ state: "running", ready: true });
    const slow = fetch(new URL("/api/slow", server.url));
    await entered.promise;
    const stopped = server.stop({ graceMs: 2_000 });
    const draining = await fetch(new URL("/.holqa/ready", server.url));
    expect([draining.status, (await draining.json() as { state: string }).state]).toEqual([503, "stopping"]);
    expect((await fetch(new URL("/.holqa/live", server.url))).status).toBe(200);
    gate.release();
    expect(await (await slow).text()).toBe("finished");
    await stopped;
  });
});