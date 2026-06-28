import { afterEach, describe, expect, it, vi } from "vitest";

const dbState = vi.hoisted(() => ({ rows: [] as unknown[] }));

vi.mock("@/lib/db/client", () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({
        where: () => ({ orderBy: () => Promise.resolve(dbState.rows) }),
      }),
    }),
  }),
}));

vi.mock("@/lib/local-packages/service", () => ({
  listSourceInstallsForLocalPackages: async () =>
    new Map([
      ["inst-9", { id: "inst-9", name: "aif", versionLabel: "aif/v1.0.0" }],
    ]),
}));

import { getProjectLocalPackages } from "@/lib/queries/project-local-packages";

afterEach(() => {
  dbState.rows = [];
});

describe("getProjectLocalPackages", () => {
  it("projects rows and resolves forked vs local origin", async () => {
    dbState.rows = [
      {
        id: "lp-1",
        name: "aif (local)",
        slug: "aif-local",
        isDefault: true,
        sourceInstallId: "inst-9",
      },
      {
        id: "lp-2",
        name: "scratch",
        slug: "scratch",
        isDefault: false,
        sourceInstallId: null,
      },
    ];

    const result = await getProjectLocalPackages("proj-1");

    expect(result).toEqual([
      {
        id: "lp-1",
        name: "aif (local)",
        slug: "aif-local",
        isDefault: true,
        origin: {
          kind: "forked",
          packageName: "aif",
          versionLabel: "aif/v1.0.0",
        },
      },
      {
        id: "lp-2",
        name: "scratch",
        slug: "scratch",
        isDefault: false,
        origin: { kind: "local" },
      },
    ]);
  });
});
