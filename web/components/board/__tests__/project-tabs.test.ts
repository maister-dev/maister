import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl/server", () => ({
  getTranslations: async (ns: string) => (key: string) => `${ns}.${key}`,
}));

import { ProjectTabs } from "@/components/board/project-tabs";

describe("ProjectTabs", () => {
  it("includes Project Brain as a first-class project tab", async () => {
    const html = renderToStaticMarkup(
      await ProjectTabs({ slug: "demo", active: "brain", boardCount: 7 }),
    );

    expect(html).toContain("nav.brain");
    expect(html).toContain("/projects/demo?tab=brain");
  });

  it("renders a nested experiments tab with active state", async () => {
    const html = renderToStaticMarkup(
      await ProjectTabs({ slug: "proj", active: "experiments", boardCount: 7 }),
    );

    expect(html).toContain("nav.experiments");
    expect(html).toContain("/projects/proj/experiments");
    expect(html).toContain('aria-selected="true"');
    expect(html).not.toContain("?tab=experiments");
  });
});
