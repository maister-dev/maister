import { describe, expect, it } from "vitest";

import {
  deriveTaskKey,
  TASK_KEY_REGEX,
  uniquifyTaskKey,
  validateTaskKey,
} from "@/lib/social/task-key";

describe("TASK_KEY_REGEX / validateTaskKey", () => {
  it.each(["MAI", "AB", "A1", "MAISTERAPP", "Z9X8Y7W6V5"])(
    "accepts %s",
    (key) => {
      expect(validateTaskKey(key)).toBe(true);
    },
  );

  it.each([
    "A", // too short
    "mai", // lowercase
    "1AB", // starts with a digit
    "MAISTERAPPX", // 11 chars
    "MA-I", // dash
    "MA I", // space
    "",
  ])("rejects %j", (key) => {
    expect(validateTaskKey(key)).toBe(false);
  });
});

describe("deriveTaskKey", () => {
  it("takes the first three letters of the name, uppercased", () => {
    expect(deriveTaskKey("Maister")).toBe("MAI");
    expect(deriveTaskKey("Test Alpha")).toBe("TES");
  });

  it("skips non-letter characters in the name", () => {
    expect(deriveTaskKey("42 go-Live!")).toBe("GOL");
  });

  it("pads from the slug when the name yields fewer than two letters", () => {
    expect(deriveTaskKey("42", "answer-project")).toBe("ANS");
    expect(deriveTaskKey("X1", "yz-app")).toBe("XYZ");
  });

  it("falls back to XX padding when name and slug have no letters", () => {
    expect(deriveTaskKey("42", "1-2-3")).toBe("XX");
  });

  it("always produces a valid task key", () => {
    for (const [name, slug] of [
      ["Maister", "maister"],
      ["42", "1-2-3"],
      ["x", ""],
      ["ALL CAPS NAME", "all-caps-name"],
    ] as const) {
      expect(validateTaskKey(deriveTaskKey(name, slug))).toBe(true);
    }
  });
});

describe("uniquifyTaskKey (mirrors the 0040 backfill DO block)", () => {
  it("returns the 3-letter base when free", () => {
    expect(uniquifyTaskKey("Test Alpha", "test-alpha", () => false)).toBe(
      "TES",
    );
  });

  it("widens to four letters on first collision", () => {
    const taken = new Set(["TES"]);

    expect(
      uniquifyTaskKey("Test Alphax", "test-alphax", (c) => taken.has(c)),
    ).toBe("TEST");
  });

  it("falls to numeric suffixes when the widened key is also taken", () => {
    const taken = new Set(["TES", "TEST"]);

    expect(uniquifyTaskKey("Tes", "test-alphay", (c) => taken.has(c))).toBe(
      "TES2",
    );
  });

  it("increments the suffix until free", () => {
    const taken = new Set(["TES", "TEST", "TES2", "TES3"]);

    expect(uniquifyTaskKey("Tes", "x", (c) => taken.has(c))).toBe("TES4");
  });

  it("matches the migration ladder example MAI -> MAIS -> MAI2", () => {
    const taken = new Set<string>();
    const claim = (name: string, slug: string) => {
      const key = uniquifyTaskKey(name, slug, (c) => taken.has(c));

      taken.add(key);

      return key;
    };

    expect(claim("Maister Dev", "maister-dev")).toBe("MAI");
    expect(claim("Maister", "maister")).toBe("MAIS");
    expect(claim("Mai", "mai")).toBe("MAI2");
  });

  it("matches TASK_KEY_REGEX for every ladder step", () => {
    const taken = new Set<string>();

    for (let i = 0; i < 12; i += 1) {
      const key = uniquifyTaskKey("Tes", "tes", (c) => taken.has(c));

      expect(key).toMatch(TASK_KEY_REGEX);
      taken.add(key);
    }
  });
});
