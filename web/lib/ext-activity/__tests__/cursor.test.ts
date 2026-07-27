import { describe, expect, it } from "vitest";

import { MaisterError } from "@/lib/errors";
import {
  DEFAULT_RUN_ACTIVITY_LIMIT,
  MAX_RUN_ACTIVITY_LIMIT,
  encodeRunActivityCursor,
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
    expect(parseRunSinceId(encodeRunSinceId(0))).toEqual({
      lastMutationId: 0n,
      lastItemId: null,
    });
    expect(parseRunSinceId(encodeRunSinceId(19))).toEqual({
      lastMutationId: 19n,
      lastItemId: null,
    });
  });

  it("round-trips composite run-activity cursors", () => {
    const encoded = encodeRunActivityCursor({
      lastMutationId: 19n,
      lastItemId: "run-1:item-2",
    });

    expect(parseRunSinceId(encoded)).toEqual({
      lastMutationId: 19n,
      lastItemId: "run-1:item-2",
    });
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
    expect(() => parseRunSinceId("7:")).toThrow(MaisterError);
    expect(() => parseRunSinceId("7:%ZZ")).toThrow(MaisterError);
    expect(() => parsePulseCursor("9223372036854775808")).toThrow(MaisterError);
    expect(() => parseRunSinceId("9223372036854775808")).toThrow(MaisterError);
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
