import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_DB_URL = process.env.DB_URL;
const ORIGINAL_POOL_MAX = process.env.MAISTER_DB_POOL_MAX;

async function importFresh() {
  vi.resetModules();

  return import("@/lib/db/client");
}

describe("db client factory", () => {
  beforeEach(() => {
    delete process.env.DB_URL;
    delete process.env.MAISTER_DB_POOL_MAX;
  });

  afterEach(() => {
    if (ORIGINAL_DB_URL === undefined) {
      delete process.env.DB_URL;
    } else {
      process.env.DB_URL = ORIGINAL_DB_URL;
    }
    if (ORIGINAL_POOL_MAX === undefined) {
      delete process.env.MAISTER_DB_POOL_MAX;
    } else {
      process.env.MAISTER_DB_POOL_MAX = ORIGINAL_POOL_MAX;
    }
  });

  it("maskUrl hides the password between : and @", async () => {
    process.env.DB_URL = "file::memory:";
    const { maskUrl } = await importFresh();

    expect(maskUrl("postgres://user:secret@host:5432/dbname")).toBe(
      "postgres://user:***@host:5432/dbname",
    );
    expect(maskUrl("postgresql://u:p@h/d")).toBe("postgresql://u:***@h/d");
  });

  it("returns a Pg-backed Drizzle client when DB_URL=postgres://...", async () => {
    process.env.DB_URL = "postgres://u:p@localhost:5432/x";
    const { buildClient } = await importFresh();

    const db = buildClient();

    expect(db).toBeTruthy();
    expect(typeof db).toBe("object");
  });

  it("REQ-D5-01: configures default pool max=25 and finite timeouts, and honors MAISTER_DB_POOL_MAX", async () => {
    process.env.DB_URL = "postgres://u:p@localhost:5432/x";
    const { buildClient } = await importFresh();

    const defaultDb = buildClient();
    const defaultOptions = (
      defaultDb.$client as unknown as {
        options: {
          max?: number;
          connectionTimeoutMillis?: number;
          idleTimeoutMillis?: number;
        };
      }
    ).options;

    expect(defaultOptions).toMatchObject({
      max: 25,
      connectionTimeoutMillis: 10_000,
      idleTimeoutMillis: 30_000,
    });

    process.env.MAISTER_DB_POOL_MAX = "40";
    const overrideDb = buildClient();
    const overrideOptions = (
      overrideDb.$client as unknown as {
        options: {
          max?: number;
          connectionTimeoutMillis?: number;
          idleTimeoutMillis?: number;
        };
      }
    ).options;

    expect(overrideOptions).toMatchObject({
      max: 40,
      connectionTimeoutMillis: 10_000,
      idleTimeoutMillis: 30_000,
    });

    for (const invalid of ["", "0", "-5", "abc"]) {
      process.env.MAISTER_DB_POOL_MAX = invalid;
      const fallbackDb = buildClient();
      const fallbackOptions = (
        fallbackDb.$client as unknown as { options: { max?: number } }
      ).options;

      expect(fallbackOptions.max).toBe(25);
    }
  });
});
