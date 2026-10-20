import {
  describe,
  expect,
  it
} from "bun:test";

import {
  providedCapabilities,
  requiredCapabilities
} from "@/resources/capability-vocabulary";

describe("requiredCapabilities", () => {
  it("lists the kind and one capability per declared requirement", () => {
    expect(requiredCapabilities({ kind: "queue", requirements: { delivery: "at-least-once", deadLetter: false } })).toEqual(["queue", "queue.delivery.at-least-once"]);
    expect(requiredCapabilities({ kind: "queue", requirements: { delivery: "at-least-once", deadLetter: true, maxAttempts: 3, backoff: { strategy: "exponential", initialDelaySeconds: 1, maxDelaySeconds: 30 } } })).toEqual([
      "queue",
      "queue.delivery.at-least-once",
      "queue.dead-letter",
      "queue.max-attempts",
      "queue.backoff.exponential"
    ]);
    expect(requiredCapabilities({ kind: "bucket", requirements: { access: "public-read" } })).toEqual(["bucket", "bucket.access.public-read"]);
    expect(requiredCapabilities({ kind: "schedule", requirements: { overlap: "skip" } })).toEqual(["schedule", "schedule.overlap.skip"]);
    expect(requiredCapabilities({ kind: "http.api", requirements: {} })).toEqual(["http.api"]);
  });
});

describe("providedCapabilities", () => {
  it("names what a binding advertises in the same vocabulary", () => {
    expect(providedCapabilities("queue", { delivery: ["at-least-once"], maxAttempts: 5, deadLetter: true, backoff: ["fixed"], maxDelaySeconds: 60 })).toEqual([
      "queue",
      "queue.backoff.fixed",
      "queue.dead-letter",
      "queue.delay",
      "queue.delivery.at-least-once",
      "queue.max-attempts"
    ]);
    expect(providedCapabilities("queue", { delivery: ["at-least-once"], maxAttempts: 1, deadLetter: false })).toEqual(["queue", "queue.delivery.at-least-once", "queue.max-attempts"]);
    expect(providedCapabilities("bucket", { access: ["private"], events: ["object.created"], signedUrls: { maxExpiresInSeconds: 60 } })).toEqual([
      "bucket",
      "bucket.access.private",
      "bucket.signed-urls",
      "trigger.bucket.object-created"
    ]);
    expect(providedCapabilities("schedule", { overlap: ["allow"] })).toEqual(["schedule", "schedule.overlap.allow"]);
    expect(providedCapabilities("http.api", {})).toEqual(["http.api"]);
  });
});