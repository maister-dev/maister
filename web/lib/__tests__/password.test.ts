import { afterEach, describe, expect, it } from "vitest";

import { generateTempPassword } from "@/lib/password";

const AMBIGUOUS = ["0", "O", "o", "1", "l", "I"];
const ENV = "MAISTER_TEMP_PASSWORD_LENGTH";

afterEach(() => {
  delete process.env[ENV];
});

describe("generateTempPassword", () => {
  it("defaults to length 12", () => {
    expect(generateTempPassword()).toHaveLength(12);
  });

  it("respects an explicit length argument", () => {
    expect(generateTempPassword(20)).toHaveLength(20);
  });

  it("reads MAISTER_TEMP_PASSWORD_LENGTH when no argument is given", () => {
    process.env[ENV] = "24";
    expect(generateTempPassword()).toHaveLength(24);
  });

  it("clamps to a floor of 12 when the env value is below 12", () => {
    process.env[ENV] = "8";
    expect(generateTempPassword()).toHaveLength(12);
  });

  it("clamps to a floor of 12 for an explicit short length", () => {
    expect(generateTempPassword(4)).toHaveLength(12);
  });

  it("excludes ambiguous characters", () => {
    const pw = generateTempPassword(96);

    for (const ch of AMBIGUOUS) expect(pw).not.toContain(ch);
  });

  it("includes at least one lower, upper, digit, and special character", () => {
    for (let i = 0; i < 50; i++) {
      const pw = generateTempPassword();

      expect(pw).toMatch(/[a-z]/);
      expect(pw).toMatch(/[A-Z]/);
      expect(pw).toMatch(/[2-9]/);
      expect(pw).toMatch(/[!@#$%^&*\-_=+]/);
    }
  });

  it("produces unique values across 1000 calls", () => {
    const seen = new Set<string>();

    for (let i = 0; i < 1000; i++) seen.add(generateTempPassword());
    expect(seen.size).toBe(1000);
  });

  it("never throws for reasonable lengths", () => {
    expect(() => generateTempPassword(12)).not.toThrow();
    expect(() => generateTempPassword(128)).not.toThrow();
  });
});
