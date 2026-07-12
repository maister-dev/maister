import { afterEach, describe, expect, it, vi } from "vitest";

const dbState = vi.hoisted(() => ({ rows: [] as unknown[] }));

vi.mock("@/lib/db/client", () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({ where: () => Promise.resolve(dbState.rows) }),
    }),
  }),
}));

import {
  getAvailablePackageInstalls,
  getProjectIdsAttachedToPackage,
} from "@/lib/queries/packages";

afterEach(() => {
  dbState.rows = [];
});

// ADR-132 §c (T15): the attach picker must distinguish local cuts (installs
// carrying `source_local_package_id`) from upstream installs — the UI badges
// them and routes the name-collision explainer to the fork's editor.
describe("getAvailablePackageInstalls", () => {
  it("carries sourceLocalPackageId: the fork-cut back-edge for cuts, null for upstream installs", async () => {
    dbState.rows = [
      {
        id: "inst-up",
        name: "aif",
        versionLabel: "aif/v1.0.0",
        resolvedRevision: "a".repeat(40),
        trustStatus: "trusted_by_policy",
        manifest: { spec: { flows: [{ id: "aif-dev" }] } },
        sourceLocalPackageId: null,
      },
      {
        id: "inst-cut",
        name: "aif",
        versionLabel: "local-abcdef123456",
        resolvedRevision: "b".repeat(40),
        trustStatus: "trusted_by_policy",
        manifest: { spec: { flows: [{ id: "aif-dev" }] } },
        sourceLocalPackageId: "lp-1",
      },
    ];

    const views = await getAvailablePackageInstalls();

    expect(views.map((v) => v.sourceLocalPackageId)).toEqual([null, "lp-1"]);
    expect(views.find((v) => v.id === "inst-cut")).toMatchObject({
      name: "aif",
      versionLabel: "local-abcdef123456",
      sourceLocalPackageId: "lp-1",
      flows: ["aif-dev"],
    });
  });
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
