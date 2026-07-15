import { describe, expect, it } from "vitest";

import { MaisterError } from "@/lib/errors-core";
import {
  describeScheduledLaunchTime,
  resolveScheduledLaunchTime,
} from "@/lib/scheduled-launches/time";

describe("resolveScheduledLaunchTime", () => {
  it("resolves an unambiguous local wall time in its submitted IANA zone", () => {
    expect(
      resolveScheduledLaunchTime({
        scheduledLocalTime: "2026-06-01T10:15",
        timezone: "Europe/Moscow",
      }),
    ).toEqual(new Date("2026-06-01T07:15:00.000Z"));
  });

  it("rejects a nonexistent spring-forward wall time instead of shifting it", () => {
    expect(() =>
      resolveScheduledLaunchTime({
        scheduledLocalTime: "2026-03-08T02:30",
        timezone: "America/New_York",
      }),
    ).toThrow(
      expect.objectContaining<Partial<MaisterError>>({ code: "CONFIG" }),
    );
  });

  it("requires an explicit choice for an ambiguous fall-back wall time", () => {
    expect(() =>
      resolveScheduledLaunchTime({
        scheduledLocalTime: "2026-11-01T01:30",
        timezone: "America/New_York",
      }),
    ).toThrow(
      expect.objectContaining<Partial<MaisterError>>({ code: "CONFIG" }),
    );
  });

  it("preserves the chosen earlier or later instant for an ambiguous wall time", () => {
    const input = {
      scheduledLocalTime: "2026-11-01T01:30",
      timezone: "America/New_York",
    } as const;

    expect(
      resolveScheduledLaunchTime({ ...input, disambiguation: "earlier" }),
    ).toEqual(new Date("2026-11-01T05:30:00.000Z"));
    expect(
      resolveScheduledLaunchTime({ ...input, disambiguation: "later" }),
    ).toEqual(new Date("2026-11-01T06:30:00.000Z"));
  });

  it("returns both UTC previews for an ambiguous wall time without silently choosing one", () => {
    expect(
      describeScheduledLaunchTime({
        scheduledLocalTime: "2026-11-01T01:30",
        timezone: "America/New_York",
        disambiguation: "later",
      }),
    ).toEqual({
      earlierAt: "2026-11-01T05:30:00.000Z",
      isAmbiguous: true,
      laterAt: "2026-11-01T06:30:00.000Z",
      resolvedAt: "2026-11-01T06:30:00.000Z",
    });
  });
});
