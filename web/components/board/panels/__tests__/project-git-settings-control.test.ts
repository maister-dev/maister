import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// renderToStaticMarkup drives the initial render only — the add/manage modal is
// behind state, so it is asserted as absent here; the open-modal + add round-trip
// are covered by the T26 e2e.
vi.mock("next-intl", () => ({
  useTranslations:
    (ns: string) =>
    (key: string, vals?: Record<string, unknown>): string =>
      vals ? `${ns}.${key}:${JSON.stringify(vals)}` : `${ns}.${key}`,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

import {
  ProjectGitSettingsControl,
  type ProjectGitSettingsControlProps,
} from "@/components/board/panels/project-git-settings-control";

function render(over: Partial<ProjectGitSettingsControlProps> = {}): string {
  const props: ProjectGitSettingsControlProps = {
    projectSlug: "demo",
    mainBranch: "main",
    remotes: [{ name: "origin", url: "https://github.com/o/r.git" }],
    needsPersist: false,
    ...over,
  };

  return renderToStaticMarkup(createElement(ProjectGitSettingsControl, props));
}

describe("ProjectGitSettingsControl", () => {
  it("renders a view-only remotes table with add + manage triggers", () => {
    const html = render();

    expect(html).toContain("projects.git.remotesTitle");
    expect(html).toContain("projects.git.addRemote");
    expect(html).toContain("origin");
    expect(html).toContain("https://github.com/o/r.git");
    expect(html).toContain("projects.git.manage");
    // The modal is state-gated — not present on first render.
    expect(html).not.toContain("projects.git.addTitle");
  });

  it("shows the empty state when there are no remotes", () => {
    const html = render({ remotes: [] });

    expect(html).toContain("projects.git.empty");
    expect(html).not.toContain("projects.git.manage");
  });

  it("shows the persist action only when needsPersist", () => {
    expect(render({ needsPersist: true })).toContain(
      "projects.git.persistTitle",
    );
    expect(render({ needsPersist: false })).not.toContain(
      "projects.git.persistTitle",
    );
  });
});
