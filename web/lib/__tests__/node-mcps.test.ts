import { describe, expect, it } from "vitest";

import { firstUnknownCapabilityRef } from "@/lib/config";
import {
  aiCodingSettingsSchema,
  allNodeMcpRefs,
  normalizeNodeMcps,
} from "@/lib/config.schema";

// M27/T-C6 (§3.2): node settings.mcps gains a required/additional split with
// bare-array back-compat (= additional). The hard-gate validates BOTH branches.

describe("normalizeNodeMcps (T-C6)", () => {
  it("treats a bare string[] as additional (back-compat)", () => {
    expect(normalizeNodeMcps(["github", "postgres"])).toEqual({
      required: [],
      additional: ["github", "postgres"],
    });
  });

  it("passes a {required, additional} split through", () => {
    expect(
      normalizeNodeMcps({ required: ["github"], additional: ["postgres"] }),
    ).toEqual({ required: ["github"], additional: ["postgres"] });
  });

  it("defaults missing branches and undefined to empty", () => {
    expect(normalizeNodeMcps({ required: ["a"] })).toEqual({
      required: ["a"],
      additional: [],
    });
    expect(normalizeNodeMcps(undefined)).toEqual({
      required: [],
      additional: [],
    });
  });
});

describe("allNodeMcpRefs (T-C6)", () => {
  it("dedupes the union of required and additional", () => {
    expect(
      allNodeMcpRefs({ required: ["github"], additional: ["github", "pg"] }),
    ).toEqual(["github", "pg"]);
  });
});

describe("aiCodingSettingsSchema mcps shape (T-C6)", () => {
  it("accepts a bare string[] (back-compat)", () => {
    const parsed = aiCodingSettingsSchema.parse({ mcps: ["github"] });

    expect(parsed.mcps).toEqual(["github"]);
  });

  it("accepts a {required, additional} object", () => {
    const parsed = aiCodingSettingsSchema.parse({
      mcps: { required: ["github"], additional: ["pg"] },
    });

    expect(parsed.mcps).toEqual({ required: ["github"], additional: ["pg"] });
  });

  it("rejects an unknown key in the mcps object", () => {
    expect(() =>
      aiCodingSettingsSchema.parse({ mcps: { requiredd: ["x"] } }),
    ).toThrow();
  });
});

describe("firstUnknownCapabilityRef gates required AND additional (T-C6)", () => {
  const refs = {
    mcp: new Set(["known"]),
    skill: new Set<string>(),
    restriction: new Set<string>(),
    setting: new Set<string>(),
  };

  it("flags an unknown REQUIRED mcp ref", () => {
    expect(
      firstUnknownCapabilityRef(
        "ai_coding",
        { mcps: { required: ["nope"], additional: ["known"] } },
        refs,
      ),
    ).toEqual({ kind: "mcp", ref: "nope" });
  });

  it("flags an unknown ADDITIONAL mcp ref", () => {
    expect(
      firstUnknownCapabilityRef(
        "ai_coding",
        { mcps: { required: ["known"], additional: ["nope"] } },
        refs,
      ),
    ).toEqual({ kind: "mcp", ref: "nope" });
  });

  it("passes when every required + additional ref is known (bare back-compat too)", () => {
    expect(
      firstUnknownCapabilityRef("ai_coding", { mcps: ["known"] }, refs),
    ).toBeNull();
    expect(
      firstUnknownCapabilityRef(
        "ai_coding",
        { mcps: { required: ["known"] } },
        refs,
      ),
    ).toBeNull();
  });
});
