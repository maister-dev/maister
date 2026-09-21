import { describe, expect, it } from "vitest";

import { routeCrashRecover } from "../crash-recover-route";

const NOW = Date.UTC(2026, 8, 21, 12, 0, 0);
const GRACE = 60;

function at(secondsAgo: number): Date {
  return new Date(NOW - secondsAgo * 1000);
}

function route(
  overrides: Partial<Parameters<typeof routeCrashRecover>[0]> = {},
) {
  return routeCrashRecover({
    liveSession: false,
    resumeStartedAt: at(120),
    latestAttemptStartedAt: null,
    nowMs: NOW,
    graceSeconds: GRACE,
    ...overrides,
  });
}

describe("routeCrashRecover", () => {
  // The whole reason this decision is shared: `driveResume` closes the crashed
  // node attempts before dispatching. Against a LIVE session that closes an
  // attempt the session is still producing, and the re-prompt double-spends
  // the turn — so liveness must outrank every other signal, grace included.
  it("routes a live session to reattach regardless of the grace window", () => {
    expect(route({ liveSession: true, resumeStartedAt: at(1) })).toBe(
      "reattach",
    );
    expect(route({ liveSession: true, resumeStartedAt: at(3_600) })).toBe(
      "reattach",
    );
    expect(
      route({
        liveSession: true,
        resumeStartedAt: null,
        latestAttemptStartedAt: null,
      }),
    ).toBe("reattach");
  });

  it("yields inside the grace window — a dispatch may still be in flight", () => {
    expect(route({ resumeStartedAt: at(1) })).toBe("wait");
    expect(route({ resumeStartedAt: at(GRACE - 1) })).toBe("wait");
  });

  it("recovers past the grace window", () => {
    expect(route({ resumeStartedAt: at(GRACE + 1) })).toBe("recover");
  });

  // Strict `<`: exactly at the boundary is PAST grace, matching the sweep's
  // classifier, which is what makes the refactor byte-identical.
  it("treats the exact grace boundary as past grace", () => {
    expect(route({ resumeStartedAt: at(GRACE) })).toBe("recover");
  });

  // The anchor is the MORE RECENT of the two, so a fresh attempt keeps an old
  // resume marker inside grace rather than letting it age out on its own.
  it("anchors on the more recent of resume and latest attempt", () => {
    expect(
      route({
        resumeStartedAt: at(3_600),
        latestAttemptStartedAt: at(1),
      }),
    ).toBe("wait");
    expect(
      route({
        resumeStartedAt: at(1),
        latestAttemptStartedAt: at(3_600),
      }),
    ).toBe("wait");
    expect(
      route({
        resumeStartedAt: at(3_600),
        latestAttemptStartedAt: at(3_600),
      }),
    ).toBe("recover");
  });

  it("treats both anchors null as past grace", () => {
    expect(route({ resumeStartedAt: null, latestAttemptStartedAt: null })).toBe(
      "recover",
    );
  });
});
