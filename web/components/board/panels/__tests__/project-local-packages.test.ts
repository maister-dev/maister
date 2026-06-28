import type { ReactElement } from "react";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl/server", () => ({
  getTranslations: async () => (key: string) => key,
}));

import { ProjectLocalPackages } from "@/components/board/panels/project-local-packages";

describe("ProjectLocalPackages", () => {
  it("renders rows with badge, origin, and an edit link to the Studio editor", async () => {
    const markup = renderToStaticMarkup(
      (await ProjectLocalPackages({
        localPackages: [
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
        ],
      })) as ReactElement,
    );

    expect(markup).toContain("localTitle");
    expect(markup).toContain("aif (local)");
    expect(markup).toContain("localBadge");
    expect(markup).toContain("/studio/edit/lp-1");
  });

  it("renders nothing when there are no project-owned local packages", async () => {
    const result = await ProjectLocalPackages({ localPackages: [] });

    expect(result).toBeNull();
  });
});
