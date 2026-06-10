import { describe, expect, it } from "vitest";

import {
  DEFAULT_MAX_ATTEMPTS,
  JITTER_RATIO,
  RETRY_SCHEDULE_MS,
  applyJitter,
  baseDelayMs,
  classifyResult,
  type WebhookErrorKind,
} from "@/lib/webhooks/backoff";

// =============================================================================
// T4 — outbound-webhooks backoff + classification (TDD red).
//
// Pins the retry curve + outcome classification from
// docs/system-analytics/outbound-webhooks.md ("Retry and backoff"):
//   schedule 1m,5m,15m,1h,4h,12h,24h, max 8 attempts, ±20% jitter,
//   2xx→delivered, 410→dead(gone) immediately, attempts≥max→dead(max_attempts),
//   everything else (incl. 3xx) → retry. Module `@/lib/webhooks/backoff` does
//   not exist yet — these MUST fail with module-not-found until landed verbatim.
// =============================================================================

const MIN = 60_000;
const HOUR = 60 * MIN;

describe("constants", () => {
  it("RETRY_SCHEDULE_MS equals the 7 listed values in order", () => {
    expect([...RETRY_SCHEDULE_MS]).toEqual([
      1 * MIN, // 60000
      5 * MIN, // 300000
      15 * MIN, // 900000
      1 * HOUR, // 3600000
      4 * HOUR, // 14400000
      12 * HOUR, // 43200000
      24 * HOUR, // 86400000
    ]);
    expect(RETRY_SCHEDULE_MS).toHaveLength(7);
  });

  it("DEFAULT_MAX_ATTEMPTS is 8 (initial + 7 retries)", () => {
    expect(DEFAULT_MAX_ATTEMPTS).toBe(8);
  });

  it("JITTER_RATIO is 0.2 (±20%)", () => {
    expect(JITTER_RATIO).toBe(0.2);
  });
});

describe("baseDelayMs", () => {
  it("maps attemptCount 1..7 to the schedule entries", () => {
    expect(baseDelayMs(1)).toBe(60_000);
    expect(baseDelayMs(2)).toBe(300_000);
    expect(baseDelayMs(3)).toBe(900_000);
    expect(baseDelayMs(4)).toBe(3_600_000);
    expect(baseDelayMs(5)).toBe(14_400_000);
    expect(baseDelayMs(6)).toBe(43_200_000);
    expect(baseDelayMs(7)).toBe(86_400_000);
  });

  it("clamps beyond the schedule length to the last (24h) entry", () => {
    expect(baseDelayMs(8)).toBe(86_400_000);
    expect(baseDelayMs(99)).toBe(86_400_000);
  });
});

describe("applyJitter", () => {
  it("rng()=0 → ms*0.8 (lower bound)", () => {
    expect(applyJitter(1000, () => 0)).toBe(800);
  });

  it("rng()=1 → ms*1.2 (upper bound)", () => {
    expect(applyJitter(1000, () => 1)).toBe(1200);
  });

  it("rng()=0.5 → ms unchanged (midpoint)", () => {
    expect(applyJitter(1000, () => 0.5)).toBe(1000);
  });

  it("stays within [0.8*ms, 1.2*ms] for arbitrary rng draws (property check)", () => {
    const ms = 3_600_000;

    for (let i = 0; i < 1000; i += 1) {
      const r = Math.random();
      const out = applyJitter(ms, () => r);

      expect(out).toBeGreaterThanOrEqual(ms * 0.8);
      expect(out).toBeLessThanOrEqual(ms * 1.2);
    }
  });
});

describe("classifyResult — success", () => {
  for (const httpStatus of [200, 201, 204]) {
    it(`httpStatus ${httpStatus} → { outcome: "delivered" }`, () => {
      expect(
        classifyResult({ attemptCount: 1, maxAttempts: 8, httpStatus }),
      ).toEqual({ outcome: "delivered" });
    });
  }

  it("delivered wins even at the last attempt", () => {
    expect(
      classifyResult({ attemptCount: 8, maxAttempts: 8, httpStatus: 200 }),
    ).toEqual({ outcome: "delivered" });
  });
});

describe("classifyResult — 410 Gone (dead immediately, gone wins)", () => {
  it("410 with attemptCount < max → { dead, gone }", () => {
    expect(
      classifyResult({ attemptCount: 1, maxAttempts: 8, httpStatus: 410 }),
    ).toEqual({ outcome: "dead", reason: "gone" });
  });

  it("410 at attemptCount >= max still → { dead, gone } (gone beats max_attempts)", () => {
    expect(
      classifyResult({ attemptCount: 8, maxAttempts: 8, httpStatus: 410 }),
    ).toEqual({ outcome: "dead", reason: "gone" });
    expect(
      classifyResult({ attemptCount: 12, maxAttempts: 8, httpStatus: 410 }),
    ).toEqual({ outcome: "dead", reason: "gone" });
  });
});

describe("classifyResult — retryable HTTP failures (attemptCount < max)", () => {
  // 3xx is retryable too (redirect:"manual" — signatures never follow redirects).
  for (const httpStatus of [301, 302, 429, 500, 502]) {
    it(`httpStatus ${httpStatus} → { retry, http, delayMs = jittered baseDelayMs }`, () => {
      const attemptCount = 2;
      const result = classifyResult({
        attemptCount,
        maxAttempts: 8,
        httpStatus,
        rng: () => 0.5, // midpoint → no net jitter, delayMs == baseDelayMs
      });

      expect(result).toEqual({
        outcome: "retry",
        errorKind: "http",
        delayMs: baseDelayMs(attemptCount),
      });
    });
  }

  it("applies the injected rng to delayMs (lower bound at rng=0)", () => {
    const attemptCount = 1;
    const result = classifyResult({
      attemptCount,
      maxAttempts: 8,
      httpStatus: 500,
      rng: () => 0,
    });

    expect(result).toEqual({
      outcome: "retry",
      errorKind: "http",
      delayMs: applyJitter(baseDelayMs(attemptCount), () => 0),
    });
  });
});

describe("classifyResult — retryable transport/config errorKinds (attemptCount < max)", () => {
  const kinds: readonly Exclude<WebhookErrorKind, "http">[] = [
    "timeout",
    "network",
    "config",
  ];

  for (const errorKind of kinds) {
    it(`errorKind "${errorKind}" → { retry, "${errorKind}", jittered delayMs }`, () => {
      const attemptCount = 3;
      const result = classifyResult({
        attemptCount,
        maxAttempts: 8,
        errorKind,
        rng: () => 0.5,
      });

      expect(result).toEqual({
        outcome: "retry",
        errorKind,
        delayMs: baseDelayMs(attemptCount),
      });
    });
  }

  it('a missing-env-secret ("config") retries on the same curve', () => {
    const result = classifyResult({
      attemptCount: 1,
      maxAttempts: 8,
      errorKind: "config",
      rng: () => 0.5,
    });

    expect(result.outcome).toBe("retry");
    if (result.outcome === "retry") {
      expect(result.errorKind).toBe("config");
      expect(result.delayMs).toBe(baseDelayMs(1));
    }
  });
});

describe("classifyResult — exhaustion → dead(max_attempts)", () => {
  it("non-2xx HTTP failure at attemptCount >= max → { dead, max_attempts }", () => {
    expect(
      classifyResult({ attemptCount: 8, maxAttempts: 8, httpStatus: 500 }),
    ).toEqual({ outcome: "dead", reason: "max_attempts" });
  });

  it("3xx at attemptCount >= max → { dead, max_attempts }", () => {
    expect(
      classifyResult({ attemptCount: 8, maxAttempts: 8, httpStatus: 302 }),
    ).toEqual({ outcome: "dead", reason: "max_attempts" });
  });

  for (const errorKind of ["timeout", "network", "config"] as const) {
    it(`errorKind "${errorKind}" at attemptCount >= max → { dead, max_attempts }`, () => {
      expect(
        classifyResult({ attemptCount: 8, maxAttempts: 8, errorKind }),
      ).toEqual({ outcome: "dead", reason: "max_attempts" });
    });
  }

  it("exhaustion classification beyond max still → { dead, max_attempts }", () => {
    expect(
      classifyResult({ attemptCount: 9, maxAttempts: 8, httpStatus: 429 }),
    ).toEqual({ outcome: "dead", reason: "max_attempts" });
  });

  it("respects a custom (smaller) maxAttempts", () => {
    expect(
      classifyResult({ attemptCount: 3, maxAttempts: 3, httpStatus: 500 }),
    ).toEqual({ outcome: "dead", reason: "max_attempts" });
    // one below the custom cap is still retryable.
    expect(
      classifyResult({
        attemptCount: 2,
        maxAttempts: 3,
        httpStatus: 500,
        rng: () => 0.5,
      }),
    ).toEqual({ outcome: "retry", errorKind: "http", delayMs: baseDelayMs(2) });
  });
});
