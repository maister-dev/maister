import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_DB_URL = process.env.DB_URL;

async function importFresh() {
  vi.resetModules();

  const [client, errors] = await Promise.all([
    import("@/lib/db/client"),
    import("@/lib/errors"),
  ]);

  return { ...client, isMaisterError: errors.isMaisterError };
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

  it("throws CONFIG MaisterError when DB_URL is missing", async () => {
    const { buildClient, isMaisterError } = await importFresh();

    let caught: unknown;

    try {
      buildClient();
    } catch (e) {
      caught = e;
    }

    expect(isMaisterError(caught)).toBe(true);
    expect(isMaisterError(caught) ? caught.code : undefined).toBe("CONFIG");
  });

  it("throws CONFIG MaisterError on unsupported prefix (mysql://)", async () => {
    process.env.DB_URL = "mysql://u:supersecret@h/d";
    const { buildClient, isMaisterError } = await importFresh();

    let caught: unknown;

    try {
      buildClient();
    } catch (e) {
      caught = e;
    }

    expect(isMaisterError(caught)).toBe(true);
    expect(isMaisterError(caught) ? caught.code : undefined).toBe("CONFIG");
    expect(caught instanceof Error ? caught.message : "").not.toContain(
      "supersecret",
    );
  });

  it("returns a SQLite-backed Drizzle client for DB_URL=file::memory:", async () => {
    process.env.DB_URL = "file::memory:";
    const { buildClient } = await importFresh();

    const db = buildClient();

    expect(db).toBeTruthy();
    expect(typeof db).toBe("object");
  });

  it("returns a Pg-backed Drizzle client when DB_URL=postgres://...", async () => {
    process.env.DB_URL = "postgres://u:p@localhost:5432/x";
    const { buildClient } = await importFresh();

    const db = buildClient();

    expect(db).toBeTruthy();
    expect(typeof db).toBe("object");
  });
});
