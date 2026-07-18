import type {
  JudgePanelRow,
  MethodologyRow,
  ProfileRow,
} from "@/components/settings/evaluations/types";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
  usePathname: () => "/settings/evaluations",
}));

import { FeedbackProvider } from "@/components/feedback/feedback-provider";
import { EvaluationsSettings } from "@/components/settings/evaluations/evaluations-settings";

const methodology: MethodologyRow = {
  id: "m1",
  qualifiedId: "core:sdd-quality",
  packageName: "core",
  versionLabel: "v1.1.0",
  activation: "enabled",
  health: "ready",
  validationErrors: null,
  trustStatus: "trusted",
};

const degradedMethodology: MethodologyRow = {
  id: "m2",
  qualifiedId: "core:draft-method",
  packageName: "core",
  versionLabel: "v1.1.0",
  activation: "disabled",
  health: "degraded",
  validationErrors: ["package not trusted"],
  trustStatus: "untrusted",
};

const panel: JudgePanelRow = {
  id: "p1",
  name: "SDD Panel",
  revision: 1,
  roleBindings: [{ role: "reviewer", agentId: "core:sdd-judge" }],
  policy: {
    attempts: 3,
    maxParallelAttempts: 2,
    quorum: 2,
    timeoutMs: 600_000,
    maxRetries: 1,
    blindLabels: true,
    randomizeOrder: true,
    allowedMcps: [],
  },
  enabled: true,
};

const profile: ProfileRow = {
  id: "pr1",
  name: "SDD Profile",
  revision: 1,
  methodRevisionId: "m1",
  panelId: "p1",
  enabled: true,
};

describe("EvaluationsSettings", () => {
  it("renders three tabs with counts and the methodologies table by default", () => {
    const markup = renderToStaticMarkup(
      createElement(
        FeedbackProvider,
        null,
        createElement(EvaluationsSettings, {
          methodologies: [methodology, degradedMethodology],
          panels: [panel],
          profiles: [profile],
        }),
      ),
    );

    expect(markup).toContain("tabMethodologies");
    expect(markup).toContain("tabPanels");
    expect(markup).toContain("tabProfiles");
    // Default tab is methodologies — columns + rows present.
    expect(markup).toContain("colMethod");
    expect(markup).toContain("colHealth");
    expect(markup).toContain("core:sdd-quality");
    expect(markup).toContain("healthReady");
    expect(markup).toContain("healthDegraded");
  });

  it("gates the disable/enable action on health and surfaces validation reasons", () => {
    const markup = renderToStaticMarkup(
      createElement(
        FeedbackProvider,
        null,
        createElement(EvaluationsSettings, {
          methodologies: [degradedMethodology],
          panels: [],
          profiles: [],
        }),
      ),
    );

    // A degraded, disabled method cannot be enabled — the button is disabled and
    // titled with the reason; the validation reason is exposed via the dot title.
    expect(markup).toContain("enable");
    expect(markup).toContain("disabled");
    expect(markup).toContain("package not trusted");
  });

  it("renders an empty-state when there are no methodologies", () => {
    const markup = renderToStaticMarkup(
      createElement(
        FeedbackProvider,
        null,
        createElement(EvaluationsSettings, {
          methodologies: [],
          panels: [],
          profiles: [],
        }),
      ),
    );

    expect(markup).toContain("noMethodologies");
  });
});
