import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  nextFireAt,
  validateCronExpression,
  validateTimezone,
} from "@/lib/run-schedules/cron";
import { MaisterError } from "@/lib/errors-core";

function expectConfigError(fn: () => unknown, match: RegExp) {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(MaisterError);
    expect((err as MaisterError).code).toBe("CONFIG");
    expect((err as MaisterError).message).toMatch(match);

    return;
  }
  expect.fail("expected MaisterError(CONFIG) to be thrown");
}

describe("validateTimezone", () => {
  it("accepts valid IANA timezones", () => {
    expect(() => validateTimezone("Europe/Moscow")).not.toThrow();
    expect(() => validateTimezone("America/New_York")).not.toThrow();
    expect(() => validateTimezone("UTC")).not.toThrow();
  });

  it("rejects unknown or malformed timezones with CONFIG", () => {
    expectConfigError(() => validateTimezone("Mars/Olympus"), /timezone/i);
    expectConfigError(() => validateTimezone(""), /timezone/i);
    expectConfigError(() => validateTimezone("not a tz"), /timezone/i);
  });
});

describe("validateCronExpression", () => {
  it("accepts 5-field expressions", () => {
    expect(() => validateCronExpression("* * * * *", "UTC")).not.toThrow();
    expect(() => validateCronExpression("0 3 * * *", "UTC")).not.toThrow();
    expect(() =>
      validateCronExpression("*/15 9-17 * * 1-5", "Europe/Moscow"),
    ).not.toThrow();
  });

  it("rejects 6-field (seconds) expressions with CONFIG", () => {
    expectConfigError(
      () => validateCronExpression("0 0 3 * * *", "UTC"),
      /5-field/i,
    );
  });

  it("rejects @nickname expressions with CONFIG", () => {
    expectConfigError(
      () => validateCronExpression("@daily", "UTC"),
      /5-field/i,
    );
  });

  it("rejects garbage with CONFIG", () => {
    expectConfigError(
      () => validateCronExpression("not a cron", "UTC"),
      /cron/i,
    );
    expectConfigError(
      () => validateCronExpression("61 * * * *", "UTC"),
      /cron/i,
    );
    expectConfigError(() => validateCronExpression("", "UTC"), /cron/i);
  });

  it("rejects a never-matching expression with CONFIG", () => {
    expectConfigError(
      () => validateCronExpression("0 0 31 2 *", "UTC"),
      /never/i,
    );
  });

  it("rejects an invalid timezone through the same gate", () => {
    expectConfigError(
      () => validateCronExpression("* * * * *", "Mars/Olympus"),
      /timezone/i,
    );
  });
});

describe("nextFireAt", () => {
  it("computes the next fire in a non-DST zone (Europe/Moscow, UTC+3)", () => {
    const from = new Date("2026-06-10T08:00:00.000Z");

    const next = nextFireAt("0 12 * * *", "Europe/Moscow", from);

    expect(next.toISOString()).toBe("2026-06-10T09:00:00.000Z");
  });

  it("rolls to the next day when the slot already passed", () => {
    const from = new Date("2026-06-10T10:00:00.000Z");

    const next = nextFireAt("0 12 * * *", "Europe/Moscow", from);

    expect(next.toISOString()).toBe("2026-06-11T09:00:00.000Z");
  });

  it("preserves the minute floor (fires on whole minutes, zero seconds)", () => {
    const from = new Date("2026-06-10T10:30:45.500Z");

    const next = nextFireAt("* * * * *", "UTC", from);

    expect(next.toISOString()).toBe("2026-06-10T10:31:00.000Z");
  });

  it("fires at the first valid instant after a DST spring-forward gap", () => {
    // America/New_York 2026: clocks jump 02:00 -> 03:00 on March 8.
    // 02:30 local does not exist that day.
    const from = new Date("2026-03-08T05:00:00.000Z");

    const next = nextFireAt("30 2 * * *", "America/New_York", from);

    // croner shifts the skipped occurrence forward by the DST gap:
    // 02:30 (nonexistent) fires as 03:30 EDT (07:30Z).
    expect(next.toISOString()).toBe("2026-03-08T07:30:00.000Z");
  });

  it("fires exactly once across a DST fall-back repeated hour", () => {
    // America/New_York 2026: clocks fall back 02:00 -> 01:00 on November 1;
    // 01:30 local occurs twice (EDT then EST).
    const from = new Date("2026-11-01T04:00:00.000Z");

    const first = nextFireAt("30 1 * * *", "America/New_York", from);

    // First (EDT) occurrence: 01:30-04:00 = 05:30Z.
    expect(first.toISOString()).toBe("2026-11-01T05:30:00.000Z");

    // The next fire AFTER the repeated hour must be the NEXT day, not the
    // second (EST) occurrence of the same wall-clock time.
    const second = nextFireAt("30 1 * * *", "America/New_York", first);

    expect(second.toISOString()).toBe("2026-11-02T06:30:00.000Z");
  });

  it("throws CONFIG for a never-matching expression", () => {
    expectConfigError(
      () => nextFireAt("0 0 31 2 *", "UTC", new Date("2026-06-10T00:00:00Z")),
      /never/i,
    );
  });
});

describe("pure computation (no timers)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("never schedules a timer", () => {
    validateCronExpression("*/5 * * * *", "UTC");
    nextFireAt("*/5 * * * *", "UTC", new Date("2026-06-10T00:00:00Z"));

    expect(vi.getTimerCount()).toBe(0);
  });
});
