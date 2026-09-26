import { describe, expect, it } from "vitest";

import {
  LIBRARIAN_CONFIG_DEFAULTS,
  readLibrarianConfig,
} from "@/lib/librarian/config";

// D17 (ADR-183, ADR-188): every librarian budget is finite and validated; a
// garbage value refuses boot with CONFIG instead of silently falling back.

describe("UT-LCV-10 part: librarian budgets are finite, validated env values", () => {
  it("resolves the documented defaults when nothing is set", () => {
    expect(readLibrarianConfig({})).toEqual(LIBRARIAN_CONFIG_DEFAULTS);
    for (const value of Object.values(readLibrarianConfig({}))) {
      expect(Number.isInteger(value) && value > 0).toBe(true);
    }
  });

  it("reads an explicit positive integer", () => {
    expect(
      readLibrarianConfig({ MAISTER_LIBRARIAN_TURN_MAX_MINUTES: "25" })
        .turnMaxMinutes,
    ).toBe(25);
  });

  it.each(["0", "-3", "1.5", "ten", "", " 7x", "1e3"])(
    "refuses %j with CONFIG naming the variable",
    (raw) => {
      expect(() =>
        readLibrarianConfig({ MAISTER_LIBRARIAN_CONTEXT_MAX_CHARS: raw }),
      ).toThrowError(
        expect.objectContaining({
          code: "CONFIG",
          message: expect.stringContaining(
            "MAISTER_LIBRARIAN_CONTEXT_MAX_CHARS",
          ),
        }),
      );
    },
  );
});
