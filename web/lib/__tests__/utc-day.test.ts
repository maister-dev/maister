import { describe, expect, it } from "vitest";

import {
  addUtcDays,
  dateStart,
  nextDateStart,
  startOfUtcDay,
} from "@/lib/utc-day";

describe("utc-day helpers (ADR-177 D1)", () => {
  it("truncates a non-midnight instant to 00:00Z of its own UTC day", () => {
    expect(
      startOfUtcDay(new Date("2026-06-05T12:34:56.789Z")).toISOString(),
    ).toBe("2026-06-05T00:00:00.000Z");
  });

  it("is idempotent on an instant that is already a UTC midnight", () => {
    const midnight = new Date("2026-06-05T00:00:00.000Z");

    expect(startOfUtcDay(midnight).toISOString()).toBe(midnight.toISOString());
  });

  it("truncates by UTC, not by local time", () => {
    // 23:30Z belongs to the 5th in UTC even where the local calendar says the 6th.
    expect(
      startOfUtcDay(new Date("2026-06-05T23:30:00.000Z")).toISOString(),
    ).toBe("2026-06-05T00:00:00.000Z");
  });

  it("adds and subtracts whole days across a leap day", () => {
    expect(
      addUtcDays(new Date("2028-02-28T00:00:00.000Z"), 1).toISOString(),
    ).toBe("2028-02-29T00:00:00.000Z");
    expect(
      addUtcDays(new Date("2028-03-01T00:00:00.000Z"), -1).toISOString(),
    ).toBe("2028-02-29T00:00:00.000Z");
  });

  it("adds and subtracts whole days across a year boundary", () => {
    expect(
      addUtcDays(new Date("2026-12-31T00:00:00.000Z"), 1).toISOString(),
    ).toBe("2027-01-01T00:00:00.000Z");
    expect(
      addUtcDays(new Date("2027-01-01T00:00:00.000Z"), -1).toISOString(),
    ).toBe("2026-12-31T00:00:00.000Z");
  });

  it("does not mutate its input", () => {
    const input = new Date("2026-06-05T12:00:00.000Z");

    addUtcDays(input, 5);
    startOfUtcDay(input);

    expect(input.toISOString()).toBe("2026-06-05T12:00:00.000Z");
  });

  it("reads a YYYY-MM-DD date as that day's 00:00Z", () => {
    expect(dateStart("2026-05-07").toISOString()).toBe(
      "2026-05-07T00:00:00.000Z",
    );
  });

  it("turns an inclusive end date into the exclusive next 00:00Z", () => {
    expect(nextDateStart("2026-06-05").toISOString()).toBe(
      "2026-06-06T00:00:00.000Z",
    );
  });

  it("rolls nextDateStart over a month, a leap day and a year boundary", () => {
    expect(nextDateStart("2026-01-31").toISOString()).toBe(
      "2026-02-01T00:00:00.000Z",
    );
    expect(nextDateStart("2028-02-28").toISOString()).toBe(
      "2028-02-29T00:00:00.000Z",
    );
    expect(nextDateStart("2026-12-31").toISOString()).toBe(
      "2027-01-01T00:00:00.000Z",
    );
  });
});
