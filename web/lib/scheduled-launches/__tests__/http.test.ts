import { describe, expect, it } from "vitest";

import { MaisterError } from "@/lib/errors-core";
import {
  createScheduledLaunchBodySchema,
  parseIfMatch,
  patchScheduledLaunchBodySchema,
} from "@/lib/scheduled-launches/http";

describe("scheduled launch HTTP contract", () => {
  it("accepts only the stored public launch subset", () => {
    expect(
      createScheduledLaunchBodySchema.parse({
        taskId: "6a975ccd-e279-4783-9e6e-2439e0466a99",
        scheduledLocalTime: "2026-11-01T01:30",
        timezone: "America/New_York",
        disambiguation: "later",
        launchRequest: { flowId: "maintenance", autoPromote: false },
      }),
    ).toMatchObject({
      timezone: "America/New_York",
      launchRequest: { flowId: "maintenance", autoPromote: false },
    });

    expect(() =>
      createScheduledLaunchBodySchema.parse({
        taskId: "6a975ccd-e279-4783-9e6e-2439e0466a99",
        scheduledLocalTime: "2026-11-01T01:30",
        timezone: "America/New_York",
        launchRequest: { flowId: "maintenance", allowConcurrent: true },
      }),
    ).toThrow();
  });

  it("requires a present, exact quoted ETag revision for every mutation", () => {
    expect(parseIfMatch('"42"')).toBe(42);

    for (const value of [null, "42", "*", '"0"', '"42", "43"']) {
      expect(() => parseIfMatch(value)).toThrow(
        expect.objectContaining<Partial<MaisterError>>({ code: "CONFLICT" }),
      );
    }
  });

  it("requires every re-arm field rather than silently retaining old intent values", () => {
    expect(() =>
      patchScheduledLaunchBodySchema.parse({
        timezone: "UTC",
        launchRequest: { flowId: "maintenance" },
      }),
    ).toThrow();
  });
});
