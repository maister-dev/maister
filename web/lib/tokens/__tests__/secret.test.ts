import { describe, expect, it } from "vitest";

import {
  generateToken,
  hashToken,
  tokenPrefix,
  safeEqualHex,
} from "@/lib/tokens/secret";

describe("lib/tokens/secret — pure crypto helpers", () => {
  describe("generateToken()", () => {
    it("returns secret starting with 'mai_'", () => {
      const { secret } = generateToken();

      expect(secret).toMatch(/^mai_/);
    });

    it("returns prefix equal to secret.slice(0, 12)", () => {
      const { secret, prefix } = generateToken();

      expect(prefix).toBe(secret.slice(0, 12));
    });

    it("returns hash equal to sha256hex(secret)", () => {
      const { secret, hash } = generateToken();
      const expectedHash = hashToken(secret);

      expect(hash).toBe(expectedHash);
    });

    it("generates consistent 32-byte-derived secret length", () => {
      const lengths: number[] = [];

      for (let i = 0; i < 10; i++) {
        const { secret } = generateToken();

        lengths.push(secret.length);
      }
      // All lengths should be the same (32 random bytes → base64url → consistent length)
      const uniqueLengths = new Set(lengths);

      expect(uniqueLengths.size).toBe(1);
      // mai_ (4 chars) + base64url(32 bytes) = 4 + 43 = 47
      expect(lengths[0]).toBe(47);
    });
  });

  describe("hashToken()", () => {
    it("is deterministic", () => {
      const secret = "mai_test-secret-32-bytes-long-!!";
      const hash1 = hashToken(secret);
      const hash2 = hashToken(secret);

      expect(hash1).toBe(hash2);
    });

    it("returns sha256 hex (64 chars lowercase)", () => {
      const secret = "mai_test-secret-32-bytes-long-!!";
      const hash = hashToken(secret);

      expect(hash).toMatch(/^[a-f0-9]{64}$/);
    });
  });

  describe("tokenPrefix()", () => {
    it("returns secret.slice(0, 12)", () => {
      const secret = "mai_abcdefghijklmnop";
      const prefix = tokenPrefix(secret);

      expect(prefix).toBe(secret.slice(0, 12));
    });
  });

  describe("safeEqualHex()", () => {
    it("returns true for equal hex strings", () => {
      const hex1 = "abcd1234efgh5678";
      const hex2 = "abcd1234efgh5678";

      expect(safeEqualHex(hex1, hex2)).toBe(true);
    });

    it("returns false for different hex strings", () => {
      const hex1 = "abcd1234efgh5678";
      const hex2 = "abcd1234efgh5679";

      expect(safeEqualHex(hex1, hex2)).toBe(false);
    });

    it("returns false for different lengths (no throw)", () => {
      const hex1 = "abcd1234";
      const hex2 = "abcd1234efgh5678";

      expect(safeEqualHex(hex1, hex2)).toBe(false);
    });

    it("returns false when one string is empty", () => {
      const hex1 = "";
      const hex2 = "abcd1234";

      expect(safeEqualHex(hex1, hex2)).toBe(false);
    });

    it("returns true when both strings are empty", () => {
      const hex1 = "";
      const hex2 = "";

      expect(safeEqualHex(hex1, hex2)).toBe(true);
    });
  });
});
