import { describe, expect, it } from "vitest";

import {
  MaisterError,
  isMaisterError,
  type MaisterErrorCode,
} from "@/lib/errors";

describe("MaisterError", () => {
  it("sets name, code, message on construction", () => {
    const err = new MaisterError("CONFIG", "bad config");

    expect(err.name).toBe("MaisterError");
    expect(err.code).toBe("CONFIG");
    expect(err.message).toBe("bad config");
  });

  it("supports the standard ErrorOptions { cause } chain", () => {
    const cause = new Error("root");
    const err = new MaisterError("CRASH", "boom", { cause });

    expect(err.cause).toBe(cause);
  });

  it("survives throw + catch as MaisterError", () => {
    try {
      throw new MaisterError("PRECONDITION", "no");
    } catch (caught) {
      expect(caught).toBeInstanceOf(MaisterError);
      expect(caught).toBeInstanceOf(Error);
      if (caught instanceof MaisterError) {
        expect(caught.code).toBe("PRECONDITION");
      }
    }
  });

  it("survives Promise reject + await as MaisterError", async () => {
    const promise = Promise.reject(new MaisterError("HITL_TIMEOUT", "tick"));

    await expect(promise).rejects.toBeInstanceOf(MaisterError);
    await expect(promise).rejects.toMatchObject({ code: "HITL_TIMEOUT" });
  });
});

describe("isMaisterError", () => {
  it("returns true for MaisterError instances", () => {
    expect(isMaisterError(new MaisterError("SPAWN", "x"))).toBe(true);
  });

  it("returns false for plain Error", () => {
    expect(isMaisterError(new Error("nope"))).toBe(false);
  });

  it("returns false for null / undefined / plain objects", () => {
    expect(isMaisterError(null)).toBe(false);
    expect(isMaisterError(undefined)).toBe(false);
    expect(isMaisterError({ code: "CONFIG" })).toBe(false);
    expect(isMaisterError("string")).toBe(false);
  });
});

describe("MaisterErrorCode exhaustiveness", () => {
  it("covers all 11 codes (compile-time satisfies check)", () => {
    const CODES = [
      "PRECONDITION",
      "SPAWN",
      "NEEDS_INPUT",
      "HITL_TIMEOUT",
      "CRASH",
      "CONFLICT",
      "CONFIG",
      "EXECUTOR_UNAVAILABLE",
      "FLOW_INSTALL",
      "ACP_PROTOCOL",
      "CHECKPOINT",
    ] as const satisfies readonly MaisterErrorCode[];

    expect(CODES).toHaveLength(11);
    for (const code of CODES) {
      const err = new MaisterError(code, "x");

      expect(err.code).toBe(code);
    }
  });
});
