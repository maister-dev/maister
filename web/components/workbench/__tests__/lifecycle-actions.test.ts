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

import { WorkbenchLifecycleActions } from "@/components/workbench/lifecycle-actions";

type Props = Parameters<typeof WorkbenchLifecycleActions>[0];

function render(over: Partial<Props> = {}): string {
  return renderToStaticMarkup(
    createElement(WorkbenchLifecycleActions, {
      runId: "run-1",
      runKind: "flow",
      actions: ["archive", "drop", "exportBranch"],
      ...over,
    }),
  );
}

describe("WorkbenchLifecycleActions", () => {
  it("renders one control per allowed lifecycle action", () => {
    const html = render();

    expect(html).toContain("workbenchLifecycle.action.archive");
    expect(html).toContain("workbenchLifecycle.action.drop");
    expect(html).toContain("workbenchLifecycle.action.snapshotCommit");
    expect(html).toContain("workbenchLifecycle.action.exportBranch");
    expect(html).not.toContain("workbenchLifecycle.action.stop");
  });

  it("renders nothing when no lifecycle action is allowed", () => {
    expect(render({ actions: [] })).toBe("");
  });

  it("can render the stop-only live-workbench surface", () => {
    const html = render({ actions: ["stop"] });

    expect(html).toContain("workbenchLifecycle.action.stop");
    expect(html).not.toContain("workbenchLifecycle.action.archive");
  });
});
