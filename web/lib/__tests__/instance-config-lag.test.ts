import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  configuredEventStreamLagAgeMs,
  eventStreamLagSeconds,
  initializeEventStreamLagConfig,
} from "@/lib/instance-config";

const ENV_NAME = "MAISTER_EVENT_STREAM_LAG_SECONDS";
let saved: string | undefined;

beforeEach(() => {
  saved = process.env[ENV_NAME];
  delete process.env[ENV_NAME];
});

afterEach(() => {
  if (saved === undefined) delete process.env[ENV_NAME];
  else process.env[ENV_NAME] = saved;
});

describe("eventStreamLagSeconds", () => {
  it("defaults only when the value is absent", () => {
    expect(eventStreamLagSeconds()).toBe(120);
    process.env[ENV_NAME] = "121";
    expect(eventStreamLagSeconds()).toBe(121);
  });

  it("initializes the runtime threshold once as milliseconds", () => {
    process.env[ENV_NAME] = "121";

    expect(initializeEventStreamLagConfig()).toBe(121_000);
    process.env[ENV_NAME] = "invalid-after-boot";
    expect(configuredEventStreamLagAgeMs()).toBe(121_000);
  });

  it.each(["", "0", "-1", "1.5", "01", " 120", "120s"])(
    "rejects noncanonical value %j",
    (value) => {
      process.env[ENV_NAME] = value;

      expect(() => eventStreamLagSeconds()).toThrow(
        expect.objectContaining({ code: "CONFIG" }),
      );
    },
  );

  it("rejects a seconds value whose millisecond conversion is unsafe", () => {
    process.env[ENV_NAME] = String(
      Math.floor(Number.MAX_SAFE_INTEGER / 1000) + 1,
    );

    expect(() => eventStreamLagSeconds()).toThrow(
      expect.objectContaining({ code: "CONFIG" }),
    );
  });
});
