import { afterEach, describe, expect, it } from "vitest";

import {
  assertBrainProvisioned,
  assertProjectBrainEnabled,
  isBrainProvisioned,
  isProjectBrainEnabled,
} from "@/lib/brain/guard";
import { isMaisterError } from "@/lib/errors";

// T1.4 / E-11: the Brain is disabled in SQLite mode (D3). The dialect decision
// is DB_URL-driven (mirrors buildClient); service entrypoints fail closed.
describe("brain dialect guard (D3, E-11)", () => {
  const original = process.env.DB_URL;

  afterEach(() => {
    if (original === undefined) delete process.env.DB_URL;
    else process.env.DB_URL = original;
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

// The ONE kill-switch predicate (F1 recurrence-proof): every consumer derives
// enablement from these two functions.
describe("project brain kill-switch guard", () => {
  function stubDb(enabled: boolean | undefined) {
    return {
      execute: async () => ({
        rows: enabled === undefined ? [] : [{ brain_enabled: enabled }],
      }),
    };
  }

  it("isProjectBrainEnabled reflects projects.brain_enabled", async () => {
    expect(await isProjectBrainEnabled(stubDb(true), "p1")).toBe(true);
    expect(await isProjectBrainEnabled(stubDb(false), "p1")).toBe(false);
  });

  it("a missing project row counts as disabled (fail closed)", async () => {
    expect(await isProjectBrainEnabled(stubDb(undefined), "p1")).toBe(false);
  });

  it("assertProjectBrainEnabled throws CONFIG when disabled", async () => {
    await expect(
      assertProjectBrainEnabled(stubDb(false), "p1"),
    ).rejects.toMatchObject({ code: "CONFIG" });
    await expect(
      assertProjectBrainEnabled(stubDb(true), "p1"),
    ).resolves.toBeUndefined();
  });
});
