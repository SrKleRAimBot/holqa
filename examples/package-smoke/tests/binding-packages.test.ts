import {
  createBindingManifest,
  defineBindings,
  environmentConfig,
  inspectBindings,
  resolveBindings
} from "@holqa/bindings";
import {
  defineProviderTests,
  providerTest,
  queueConformance
} from "@holqa/conformance";
import { container } from "@holqa/container";
import { credentialRef } from "@holqa/core";
import { otlp } from "@holqa/opentelemetry";
import { rabbitmq } from "@holqa/rabbitmq";
import { s3 } from "@holqa/s3";
import {
  bucket,
  defineApp,
  http,
  queue
} from "@holqa/sdk";
import {
  describe,
  expect,
  it
} from "bun:test";
import { z } from "zod";

describe("binding packages through their built outputs", () => {
  it("composes providers from several packages into a binding manifest without credential values", () => {
    const app = defineApp({ name: "binding-smoke", resources: { api: http.api({ id: "api", basePath: "/api" }), jobs: queue({ id: "jobs", message: z.object({ n: z.number() }), schemaVersion: 1 }), files: bucket({ id: "files", access: "private" }) } });
    const host = container.host();
    const bindings = defineBindings(app, {
      name: "staging",
      kinds: { "http.api": host, "queue": rabbitmq.queues({ url: credentialRef("QUEUE_URL") }), "bucket": s3.buckets({ endpoint: "http://object-store:9000", accessKeyId: credentialRef("S3_ACCESS_KEY_ID"), secretAccessKey: credentialRef("S3_SECRET_ACCESS_KEY") }) },
      services: { config: environmentConfig(), telemetry: otlp.telemetry({ endpoint: "http://collector:4318" }) }
    });
    const report = inspectBindings(resolveBindings(bindings));
    expect(report.diagnostics).toEqual([]);
    const manifest = createBindingManifest(report, { applicationManifest: `sha256:${"0".repeat(64)}` });
    expect(manifest.credentials).toEqual(["QUEUE_URL", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"]);
    expect(manifest.resources.map(resource => [resource.id, resource.provider])).toEqual([["api", "container"], ["files", "s3"], ["jobs", "rabbitmq"]]);
    expect(typeof rabbitmq.provisioner).toBe("function");
    expect(typeof s3.provisioner).toBe("function");
    expect(defineProviderTests([providerTest("queues", queueConformance, { open: async () => {
      throw new Error("unused");
    }, time: { advance: async () => {} } })]).entries).toHaveLength(1);
  });
});