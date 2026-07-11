import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_DB_URL = process.env.DB_URL;

async function importFresh() {
  vi.resetModules();

  return import("@/lib/db/client");
}

describe("db client factory", () => {
  beforeEach(() => {
    delete process.env.DB_URL;
  });

  afterEach(() => {
    if (ORIGINAL_DB_URL === undefined) {
      delete process.env.DB_URL;
    } else {
      process.env.DB_URL = ORIGINAL_DB_URL;
    }
  });

  it("maskUrl hides the password between : and @", async () => {
    process.env.DB_URL = "file::memory:";
    const { maskUrl } = await importFresh();

    expect(maskUrl("postgres://user:secret@host:5432/dbname")).toBe(
      "postgres://user:***@host:5432/dbname",
    );
    expect(maskUrl("postgresql://u:p@h/d")).toBe("postgresql://u:***@h/d");
    expect(maskUrl("file:./dev.db")).toBe("file:./dev.db");
  });

  it("returns a Pg-backed Drizzle client when DB_URL=postgres://...", async () => {
    process.env.DB_URL = "postgres://u:p@localhost:5432/x";
    const { buildClient } = await importFresh();

    const db = buildClient();

    expect(db).toBeTruthy();
    expect(typeof db).toBe("object");
  });
});
