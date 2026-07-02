import { afterEach, describe, expect, it } from "vitest";

import { assertBrainProvisioned, isBrainProvisioned } from "@/lib/brain/guard";
import { isMaisterError } from "@/lib/errors";

// T1.4 / E-11: the Brain is disabled in SQLite mode (D3). The dialect decision
// is DB_URL-driven (mirrors buildClient); service entrypoints fail closed.
describe("brain dialect guard (D3, E-11)", () => {
  const original = process.env.DB_URL;

  afterEach(() => {
    process.env.DB_URL = original;
  });

  it("isBrainProvisioned is false under DB_URL=file: (SQLite)", () => {
    process.env.DB_URL = "file:./dev.db";
    expect(isBrainProvisioned()).toBe(false);
  });

  it("isBrainProvisioned is true under a postgres:// URL", () => {
    process.env.DB_URL = "postgres://u:p@localhost:5432/db";
    expect(isBrainProvisioned()).toBe(true);
  });

  it("assertBrainProvisioned throws PRECONDITION under SQLite", () => {
    process.env.DB_URL = "file:./dev.db";
    let thrown: unknown;

    try {
      assertBrainProvisioned();
    } catch (err) {
      thrown = err;
    }

    expect(isMaisterError(thrown)).toBe(true);
    expect(isMaisterError(thrown) && thrown.code).toBe("PRECONDITION");
  });

  it("assertBrainProvisioned does not throw under Postgres", () => {
    process.env.DB_URL = "postgres://u:p@localhost:5432/db";
    expect(() => assertBrainProvisioned()).not.toThrow();
  });
});
