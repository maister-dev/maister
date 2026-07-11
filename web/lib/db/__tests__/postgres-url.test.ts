import { describe, expect, it } from "vitest";

import { isMaisterError } from "@/lib/errors";

import { maskDbUrl, resolvePostgresDbUrl } from "../postgres-url";

describe("Postgres DB URL boundary", () => {
  it.each([
    ["missing", undefined],
    ["malformed", "not a url"],
    ["SQLite", "file:./dev.db"],
    ["another SQL dialect", "mysql://user:secret@host/db"],
  ])(
    "rejects %s configuration without leaking credentials",
    (_label, value) => {
      let caught: unknown;

      try {
        resolvePostgresDbUrl(value);
      } catch (error) {
        caught = error;
      }

      expect(isMaisterError(caught)).toBe(true);
      expect(isMaisterError(caught) ? caught.code : undefined).toBe("CONFIG");
      expect(caught instanceof Error ? caught.message : "").toContain(
        "Postgres DB_URL is required",
      );
      expect(caught instanceof Error ? caught.message : "").not.toContain(
        "secret",
      );
    },
  );

  it.each([
    "postgres://user:secret@host:5432/db",
    "postgresql://user:secret@host/db",
  ])("accepts %s and masks its password for logs", (value) => {
    expect(resolvePostgresDbUrl(value)).toBe(value);
    expect(maskDbUrl(value)).toBe(value.replace(":secret@", ":***@"));
  });
});
