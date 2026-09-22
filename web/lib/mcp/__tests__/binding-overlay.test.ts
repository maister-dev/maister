import { describe, expect, it } from "vitest";

import { MaisterError } from "@/lib/errors";
import {
  assertOverlayAgainstSlots,
  type McpTargetSlots,
} from "@/lib/mcp/binding-service";

// ADR-129 (W-C): config_overlay is validated against the target's DECLARED
// slots. Unknown slot -> CONFIG. Remap values must be env:NAME. args/url are
// non-secret overrides with no slot constraint.

const slots: McpTargetSlots = {
  env: ["GITHUB_TOKEN", "GH_HOST"],
  header: ["Authorization"],
};

describe("assertOverlayAgainstSlots (W-C)", () => {
  it("accepts an empty overlay", () => {
    expect(() => assertOverlayAgainstSlots({}, slots)).not.toThrow();
  });

  it("accepts a remap onto a declared env slot", () => {
    expect(() =>
      assertOverlayAgainstSlots(
        { envRemap: { GITHUB_TOKEN: "env:PROJ_A_GH" } },
        slots,
      ),
    ).not.toThrow();
  });

  it("rejects an unknown env slot with CONFIG", () => {
    try {
      assertOverlayAgainstSlots({ envRemap: { NOT_A_SLOT: "env:X" } }, slots);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(MaisterError);
      expect((err as MaisterError).code).toBe("CONFIG");
      expect((err as MaisterError).message).toContain("NOT_A_SLOT");
    }
  });

  it("rejects an unknown header slot with CONFIG", () => {
    expect(() =>
      assertOverlayAgainstSlots({ headerRemap: { "X-Nope": "env:Y" } }, slots),
    ).toThrow(MaisterError);
  });

  // OBSOLETE under ADR-179 (D32): overlay values share the server grammar, so a
  // literal is a legitimate override (a project pointing GH_HOST at its own
  // enterprise host needs no supervisor variable). Only a MALFORMED reference is
  // refused — that predicate is what this pair of cases now pins.
  it("accepts a LITERAL remap value", () => {
    expect(() =>
      assertOverlayAgainstSlots(
        { envRemap: { GITHUB_TOKEN: "ghe.internal" } },
        slots,
      ),
    ).not.toThrow();
  });

  it("rejects a malformed env: remap value with CONFIG", () => {
    try {
      assertOverlayAgainstSlots(
        { envRemap: { GITHUB_TOKEN: "env:1BAD" } },
        slots,
      );
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as MaisterError).code).toBe("CONFIG");
    }
  });

  it("accepts args/url overrides without slot validation", () => {
    expect(() =>
      assertOverlayAgainstSlots(
        {
          argsOverride: ["--flag", "v"],
          urlOverride: "https://p-a.example/mcp",
        },
        slots,
      ),
    ).not.toThrow();
  });
});
