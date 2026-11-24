import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
  useTranslations:
    (namespace: string) => (key: string, values?: { name: string }) =>
      `${namespace}.${key}${values ? ` ${values.name}` : ""}`,
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
    expect(html).not.toContain(
      "/Users/developer/.maister/worktrees/myapp/run-1",
    );
  });

  it("shows the selected supervisor and workspace handle for addressed takeover", () => {
    const html = renderToStaticMarkup(
      createElement(RunTakeoverActions, {
        addressedCheckout: {
          hostName: "Local supervisor B",
          handle: "ws_354c9b5edffe43f0b3a53ffd05b047ef",
        },
        branch: "fixture",
        canAct: true,
        isOwner: true,
        mode: "working",
        runId: "run-1",
        worktreePath: "/path/from/another/machine",
      }),
    );
    expect(html).toContain("Local supervisor B");
    expect(html).toContain("ws_354c9b5edffe43f0b3a53ffd05b047ef");
    expect(html).not.toContain("/path/from/another/machine");
  });
});
