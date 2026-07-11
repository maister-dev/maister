import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  FlowEditorTabs: vi.fn(() => null),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("next-intl", () => ({
  useLocale: () => "en",
  useTranslations: () => (key: string) => key,
}));
vi.mock("@/components/flows/flow-editor-tabs", () => ({
  FlowEditorTabs: mocks.FlowEditorTabs,
}));
vi.mock("@/components/studio/studio-ai-tab", () => ({
  StudioAiTab: () => null,
}));

import { LocalPackageEditor } from "@/components/studio/local-package-editor";

function renderBlockingEditor(): string {
  return renderToStaticMarkup(
    createElement(LocalPackageEditor, {
      blockingValidationMessage:
        "legacy steps[] flows are not supported since engine 3.0.0; republish the package with nodes[]",
      bom: {} as never,
      canManage: true,
      canvasAvailable: false,
      diff: "",
      fileKindLabels: {} as never,
      files: [],
      filesLabels: {} as never,
      flowPath: "flows/aif/flow.yaml",
      identity: { kind: "flow", project: "Aif", slug: "aif" },
      initialLock: { held: true, heldByMe: true, holderLabel: null },
      initialManifest: null,
      initialTitle: "Aif",
      initialYaml: "",
      labels: {
        ai: {} as never,
        aiCollapse: "Collapse AI",
        aiExpand: "Expand AI",
        aiWorking: "AI working",
        changeReview: {} as never,
        commitState: "Commit state",
        crumbLocal: "Local",
        crumbStudio: "Studio",
        diff: {} as never,
        diffView: {} as never,
        editor: {
          editor: {
            nodeForm: {
              consensus: { agentsGroup: "Agents", runnersGroup: "Runners" },
            },
          },
        } as never,
        endEdit: "End edit",
        home: { save: "Save" },
        lockLost: "Lock lost",
        readOnlyHeld: "Locked",
        readOnlyUnknownHolder: "Locked",
        reload: "Reload",
        saved: "Saved",
        saveFailed: "Save failed",
        saving: "Saving",
        tabAi: "AI",
      } as never,
      layout: null,
      mcpCatalog: [],
      packageId: "local-1",
      skillId: null,
      topology: null,
    }),
  );
}

describe("LocalPackageEditor blocking graph compatibility", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows the refusal, disables Commit and Publish, and suppresses the canvas", () => {
    const html = renderBlockingEditor();

    expect(html).toContain('data-testid="local-editor-blocking-validation"');
    expect(html).toContain(
      "legacy steps[] flows are not supported since engine 3.0.0",
    );
    expect(html).toMatch(
      /data-testid="local-editor-commit-state"[^>]*disabled=""/,
    );
    expect(html).toMatch(/data-testid="local-editor-publish"[^>]*disabled=""/);
    expect(mocks.FlowEditorTabs).toHaveBeenCalledWith(
      expect.objectContaining({ canvasAvailable: false }),
      undefined,
    );
  });
});
