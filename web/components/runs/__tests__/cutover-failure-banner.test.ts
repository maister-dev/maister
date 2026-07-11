import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CutoverFailureBanner } from "@/components/runs/cutover-failure-banner";

describe("CutoverFailureBanner", () => {
  it("keeps the upgrade reason and retained inspection paths accessible without terminal controls", () => {
    const html = renderToStaticMarkup(
      createElement(CutoverFailureBanner, {
        labels: {
          title: "Failed during upgrade",
          reason: "Legacy steps run was closed",
          history: "History",
          evidence: "Evidence",
          worktree: "Worktree",
        },
        locale: "en",
        occurredAt: new Date("2026-07-11T10:15:00.000Z"),
        runId: "run-cutover",
      }),
    );

    expect(html).toContain('role="alert"');
    expect(html).toContain('dateTime="2026-07-11T10:15:00.000Z"');
    expect(html).toContain("/runs/run-cutover?wb=timeline");
    expect(html).toContain("/runs/run-cutover?wb=evidence");
    expect(html).toContain("/runs/run-cutover?wb=files");
    expect(html).not.toMatch(/recover|resume|respond|promote|retry/i);
  });
});
