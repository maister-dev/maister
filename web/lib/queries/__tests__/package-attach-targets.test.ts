import { afterEach, describe, expect, it, vi } from "vitest";

const dbState = vi.hoisted(() => ({ rows: [] as unknown[] }));

vi.mock("@/lib/db/client", () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({ where: () => Promise.resolve(dbState.rows) }),
    }),
  }),
}));

import { getProjectIdsAttachedToPackage } from "@/lib/queries/packages";

afterEach(() => {
  dbState.rows = [];
});

describe("getProjectIdsAttachedToPackage", () => {
  it("returns the deduped set of project ids the package is attached to", async () => {
    dbState.rows = [
      { projectId: "p1" },
      { projectId: "p2" },
      { projectId: "p1" },
    ];

    const result = await getProjectIdsAttachedToPackage("aif");

    expect([...result].sort()).toEqual(["p1", "p2"]);
  });

  it("returns [] when the package is attached nowhere", async () => {
    expect(await getProjectIdsAttachedToPackage("ghost")).toEqual([]);
  });
});
