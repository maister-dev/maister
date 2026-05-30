import { describe, expect, it } from "vitest";

import {
  platformStatusDotClass,
  platformStatusLabel,
} from "@/components/chrome/platform-status";

describe("platform status presentation", () => {
  it("renders ready labels and tone", () => {
    const status = {
      kind: "ready" as const,
      health: {
        status: "ready" as const,
        version: "0.0.1",
        uptimeMs: 12,
        checkedAt: "2026-05-30T12:00:00.000Z",
        sessions: { live: 1, exited: 0, crashed: 0 },
      },
    };

    expect(
      platformStatusLabel(status, {
        ready: "Ready",
        unavailable: "Unavailable",
      }),
    ).toBe("Ready");
    expect(platformStatusDotClass(status)).toContain("bg-accent-4");
  });

  it("renders unavailable labels and tone", () => {
    const status = {
      kind: "unavailable" as const,
      reason: "network" as const,
      message: "fetch failed",
    };

    expect(
      platformStatusLabel(status, {
        ready: "Ready",
        unavailable: "Unavailable",
      }),
    ).toBe("Unavailable");
    expect(platformStatusDotClass(status)).toContain("bg-red-500");
  });
});
