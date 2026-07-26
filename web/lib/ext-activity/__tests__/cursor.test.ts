import { describe, expect, it } from "vitest";

import { MaisterError } from "@/lib/errors";
import {
  DEFAULT_RUN_ACTIVITY_LIMIT,
  MAX_RUN_ACTIVITY_LIMIT,
  encodePulseCursor,
  encodeRunSinceId,
  parsePulseCursor,
  parseRunActivityLimit,
  parseRunSinceId,
} from "@/lib/ext-activity/cursor";

describe("ext activity cursor helpers", () => {
  it("round-trips pulse cursors as opaque strings", () => {
    const encoded = encodePulseCursor(42);

    expect(parsePulseCursor(encoded)).toBe(42n);
  });

  it("round-trips run mutation horizons including zero", () => {
    expect(parseRunSinceId(encodeRunSinceId(0))).toBe(0n);
    expect(parseRunSinceId(encodeRunSinceId(19))).toBe(19n);
  });

  it("treats absent cursors as bootstrap requests", () => {
    expect(parsePulseCursor(null)).toBeNull();
    expect(parsePulseCursor(undefined)).toBeNull();
    expect(parseRunSinceId(null)).toBeNull();
    expect(parseRunSinceId(undefined)).toBeNull();
  });

  it("rejects malformed cursor values", () => {
    expect(() => parsePulseCursor("nope")).toThrow(MaisterError);
    expect(() => parseRunSinceId("-1")).toThrow(MaisterError);
    expect(() => parseRunSinceId("1.5")).toThrow(MaisterError);
  });

  it("uses the default run-activity limit when omitted", () => {
    expect(parseRunActivityLimit(null)).toBe(DEFAULT_RUN_ACTIVITY_LIMIT);
    expect(parseRunActivityLimit(undefined)).toBe(DEFAULT_RUN_ACTIVITY_LIMIT);
  });

  it("accepts explicit run-activity limits inside the configured bounds", () => {
    expect(parseRunActivityLimit("1")).toBe(1);
    expect(parseRunActivityLimit(String(MAX_RUN_ACTIVITY_LIMIT))).toBe(
      MAX_RUN_ACTIVITY_LIMIT,
    );
  });

  it("rejects run-activity limits outside the configured bounds", () => {
    expect(() => parseRunActivityLimit("0")).toThrow(MaisterError);
    expect(() =>
      parseRunActivityLimit(String(MAX_RUN_ACTIVITY_LIMIT + 1)),
    ).toThrow(MaisterError);
    expect(() => parseRunActivityLimit("not-a-number")).toThrow(MaisterError);
  });
});
