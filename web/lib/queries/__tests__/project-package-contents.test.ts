import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  attachments: vi.fn(),
  bom: vi.fn(),
}));

vi.mock("@/lib/queries/packages", () => ({
  getProjectPackageAttachments: mocks.attachments,
  getStudioPackageBom: mocks.bom,
}));

import { getProjectPackageContents } from "@/lib/queries/project-package-contents";

const flow = {
  id: "dev",
  path: "flows/dev",
  nodeCount: 2,
  gateCount: 0,
  engine: null,
  frontmatter: {
    title: null,
    summary: null,
    labels: [],
    routeWhen: null,
    links: [],
    sources: [],
  },
  graph: null,
};

describe("getProjectPackageContents", () => {
  it("returns per-package flows + non-flow counts, dropping packages with no readable BOM", async () => {
    mocks.attachments.mockResolvedValue([
      {
        packageInstallId: "inst-1",
        packageName: "aif",
        versionLabel: "aif/v1.0.0",
      },
      {
        packageInstallId: "inst-missing",
        packageName: "ghost",
        versionLabel: "ghost/v1",
      },
    ]);
    mocks.bom.mockImplementation(async (id: string) =>
      id === "inst-1"
        ? {
            flows: [flow],
            platformAgents: [{ id: "p1" }, { id: "p2" }],
            subagents: [{ id: "s1" }],
            skills: [{ id: "k1" }, { id: "k2" }, { id: "k3" }],
            mcps: [{ id: "m1" }],
            rules: [],
          }
        : null,
    );

    const result = await getProjectPackageContents("proj-1");

    expect(result).toEqual([
      {
        packageName: "aif",
        versionLabel: "aif/v1.0.0",
        flows: [flow],
        counts: { skills: 3, agents: 2, subagents: 1, mcps: 1, rules: 0 },
      },
    ]);
  });
});
