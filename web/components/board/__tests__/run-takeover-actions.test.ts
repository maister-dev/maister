import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
  useTranslations: (namespace: string) => (key: string) =>
    `${namespace}.${key}`,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

import { RunTakeoverActions } from "@/components/board/run-takeover-actions";

describe("RunTakeoverActions", () => {
  it("shows the display worktree path in checkout context", () => {
    const html = renderToStaticMarkup(
      createElement(RunTakeoverActions, {
        branch: "maister/feature-x",
        canAct: true,
        displayWorktreePath: "<maister_worktrees>/myapp/run-1",
        isOwner: true,
        mode: "working",
        runId: "run-1",
        worktreePath: "/Users/developer/.maister/worktrees/myapp/run-1",
      }),
    );

    expect(html).toContain("&lt;maister_worktrees&gt;/myapp/run-1");
    expect(html).not.toContain("/Users/developer/.maister/worktrees/myapp/run-1");
  });
});
