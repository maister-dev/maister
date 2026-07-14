import type {
  PortfolioProject,
  PortfolioWorkspace,
} from "@/lib/queries/portfolio";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// ProjectCard is an async Server Component that reads translations via
// getTranslations. Mock it with a minimal ICU-interpolating resolver so the
// {lane} token in the auto glyph tooltip renders.
vi.mock("next-intl/server", () => ({
  getTranslations:
    async (namespace: string) =>
    (key: string, values?: Record<string, unknown>) => {
      const base = `${namespace}.${key}`;

      if (!values) return base;

      return `${base}(${Object.entries(values)
        .map(([k, v]) => `${k}=${String(v)}`)
        .join(",")})`;
    },
}));

import { ProjectCard } from "@/components/portfolio/project-card";

function workspace(over: Partial<PortfolioWorkspace> = {}): PortfolioWorkspace {
  return {
    runId: "run-1",
    runKind: "flow",
    branch: "maister/docs-bump",
    agentId: null,
    triggerSource: null,
    agent: "claude",
    status: "running",
    time: "2m",
    href: "/runs/run-1",
    lifecycleActions: [],
    readiness: "ready",
    autoPromotedLane: null,
    prState: null,
    prHasConflicts: null,
    ...over,
  };
}

function project(ws: PortfolioWorkspace): PortfolioProject {
  return {
    id: "proj-1",
    slug: "demo",
    name: "Demo",
    accent: 1,
    status: "running",
    defaultAgent: "claude",
    flowsCount: 1,
    backlogCount: 0,
    pendingHitlCount: 0,
    humansCount: 1,
    agentsCount: 0,
    members: [],
    agents: ["claude"],
    activeWorkspaces: [ws],
    recentMerges: [],
    need: null,
    needsPersist: false,
  };
}

async function render(ws: PortfolioWorkspace): Promise<string> {
  return renderToStaticMarkup(await ProjectCard({ project: project(ws) }));
}

describe("ProjectCard — auto-promoted workspace glyph (ADR-126, T19)", () => {
  it("renders the auto glyph with the lane in the tooltip when a workspace was auto-promoted", async () => {
    const html = await render(workspace({ autoPromotedLane: "config" }));

    expect(html).toContain('data-testid="workspace-auto-promoted"');
    // The lane is interpolated into the portfolio.autoPromoted label.
    expect(html).toContain("lane=config");
    expect(html).toContain("auto");
  });

  it("omits the glyph on a normal active workspace (autoPromotedLane null)", async () => {
    const html = await render(workspace({ autoPromotedLane: null }));

    expect(html).not.toContain('data-testid="workspace-auto-promoted"');
  });
});
