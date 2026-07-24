import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl/server", () => ({
  getTranslations: async (ns: string) => (key: string) => `${ns}.${key}`,
}));

import { ProjectTabs } from "@/components/board/project-tabs";

describe("ProjectTabs", () => {
  it("includes Project Brain as a first-class project tab", async () => {
    const html = renderToStaticMarkup(
      await ProjectTabs({
        slug: "demo",
        active: "brain",
        boardCount: 7,
        showBrain: true,
      }),
    );

    expect(html).toContain("nav.brain");
    expect(html).toContain("/projects/demo?tab=brain");
  });

  it("does not render the retired experiments tab (ADR-150)", async () => {
    const html = renderToStaticMarkup(
      await ProjectTabs({
        slug: "proj",
        active: "board",
        boardCount: 7,
        showBrain: true,
      }),
    );

    expect(html).not.toContain("nav.experiments");
    expect(html).not.toContain("/projects/proj/experiments");
  });

  it("renders a nested evaluations tab with active state", async () => {
    const html = renderToStaticMarkup(
      await ProjectTabs({
        slug: "proj",
        active: "evaluations",
        boardCount: 7,
        showBrain: true,
      }),
    );

    expect(html).toContain("nav.evaluations");
    expect(html).toContain("/projects/proj/evaluations");
    expect(html).toContain('aria-selected="true"');
    expect(html).not.toContain("?tab=evaluations");
  });

  it("does not render the retired pull-request tab", async () => {
    const html = renderToStaticMarkup(
      await ProjectTabs({
        slug: "proj",
        active: "board",
        boardCount: 7,
        showBrain: true,
      }),
    );

    expect(html).not.toContain("nav.prs");
  });

  it("hides Project Brain when indexing is unavailable", async () => {
    const html = renderToStaticMarkup(
      await ProjectTabs({
        slug: "demo",
        active: "board",
        boardCount: 7,
        showBrain: false,
      }),
    );

    expect(html).not.toContain("nav.brain");
    expect(html).not.toContain("/projects/demo?tab=brain");
  });

  it("renders Automations and only emits the canonical tab query", async () => {
    const html = renderToStaticMarkup(
      await ProjectTabs({
        slug: "proj",
        active: "automations",
        boardCount: 7,
        showBrain: false,
      }),
    );

    expect(html).toContain("nav.automations");
    expect(html).toContain("/projects/proj?tab=automations");
    expect(html).not.toContain("?tab=schedules");
  });
});
