import type {
  AdapterReadinessCause,
  AdapterReadinessSummary,
  RailRunnerDTO,
} from "@/lib/acp-runners/readiness-summary";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  RunnersReadinessRailView,
  type RunnersReadinessLabels,
} from "@/components/chrome/runners-readiness-rail";

const labels: RunnersReadinessLabels = {
  heading: "Runners readiness",
  none: "No adapters available",
  noneConfigured: "No runners configured",
  enabledLabel: "Enabled",
  disabledLabel: "Disabled",
  configureCta: "Configure in Settings",
  readiness: { Ready: "Ready", NotReady: "Not ready", Unknown: "Unknown" },
};

const causeLabels: Record<AdapterReadinessCause, string> = {
  ready: "Ready",
  no_runner: "No runner configured",
  all_disabled: "All runners disabled",
  not_ready: "Runner not ready",
  diagnostics_unavailable: "Supervisor diagnostics unavailable",
  binary_unavailable: "Runner not ready",
};

function dto(over: Partial<RailRunnerDTO> = {}): RailRunnerDTO {
  return {
    id: "r1",
    capabilityAgent: "claude",
    model: "claude-sonnet-4-6",
    providerKind: "anthropic",
    enabled: true,
    readinessStatus: "Ready",
    firstReason: null,
    ...over,
  };
}

function summary(
  over: Partial<AdapterReadinessSummary> = {},
): AdapterReadinessSummary {
  return {
    adapter: "claude",
    state: "green",
    cause: "ready",
    detail: null,
    runners: [],
    ...over,
  };
}

function render(props: {
  adapters: AdapterReadinessSummary[];
  isAdmin: boolean;
}): string {
  return renderToStaticMarkup(
    createElement(RunnersReadinessRailView, {
      adapters: props.adapters,
      causeLabels,
      isAdmin: props.isAdmin,
      labels,
    }),
  );
}

describe("RunnersReadinessRailView", () => {
  it("renders a row per configured runner with aria-labelled enabled + readiness indicators", () => {
    const html = render({
      isAdmin: false,
      adapters: [
        summary({
          runners: [
            dto({
              id: "a",
              model: "claude-sonnet-4-6",
              providerKind: "anthropic",
            }),
            dto({
              id: "b",
              model: "glm-5.1",
              providerKind: "anthropic_compatible",
            }),
          ],
        }),
      ],
    });

    expect(html).toContain("claude-sonnet-4-6");
    expect(html).toContain("glm-5.1");
    expect(html).toContain("anthropic_compatible");
    expect(html).toContain('aria-label="Ready"');
    expect(html).toContain('aria-label="Enabled"');
  });

  it("shows the firstReason text for a not-ready runner", () => {
    const html = render({
      isAdmin: false,
      adapters: [
        summary({
          adapter: "gemini",
          state: "amber",
          cause: "not_ready",
          detail: "needs key",
          runners: [
            dto({
              id: "g",
              capabilityAgent: "gemini",
              model: "gemini-2.0",
              providerKind: "google_gemini",
              readinessStatus: "NotReady",
              firstReason: "GEMINI_API_KEY is missing",
            }),
          ],
        }),
      ],
    });

    expect(html).toContain("GEMINI_API_KEY is missing");
    expect(html).toContain('aria-label="Not ready"');
  });

  it("renders the empty state for an adapter with no runners", () => {
    const html = render({
      isAdmin: false,
      adapters: [
        summary({ adapter: "opencode", state: "amber", cause: "no_runner" }),
      ],
    });

    expect(html).toContain("No runners configured");
  });

  it("links admin chips to /settings; non-admin chips are not links", () => {
    const adapters = [summary({ runners: [dto()] })];

    const adminHtml = render({ adapters, isAdmin: true });
    const memberHtml = render({ adapters, isAdmin: false });

    expect(adminHtml).toContain('href="/settings"');
    expect(adminHtml).toContain("Configure in Settings");
    expect(memberHtml).not.toContain('href="/settings"');
    expect(memberHtml).not.toContain("Configure in Settings");
  });

  it("never renders provider secret references", () => {
    const html = render({
      isAdmin: true,
      adapters: [
        summary({
          adapter: "codex",
          runners: [dto({ providerKind: "openai_compatible" })],
        }),
      ],
    });

    expect(html).toContain("openai_compatible");
    expect(html).not.toContain("env:");
    expect(html).not.toContain("authToken");
    expect(html).not.toContain("apiKey");
  });

  it("shows disabled runners with the disabled indicator, not the empty state", () => {
    const html = render({
      isAdmin: false,
      adapters: [
        summary({
          adapter: "gemini",
          state: "amber",
          cause: "all_disabled",
          runners: [dto({ id: "g", enabled: false })],
        }),
      ],
    });

    expect(html).toContain('aria-label="Disabled"');
    expect(html).not.toContain("No runners configured");
  });

  it("gives the chip a deterministic accessible name and wires aria-describedby to the popover tooltip", () => {
    const adapters = [
      summary({
        adapter: "gemini",
        state: "amber",
        cause: "not_ready",
        detail: "needs key",
        runners: [dto({ id: "g", capabilityAgent: "gemini" })],
      }),
    ];

    for (const isAdmin of [true, false]) {
      const html = render({ adapters, isAdmin });

      // Explicit accessible name (adapter + cause), so it is NOT derived from
      // the popover subtree (Codex a11y finding).
      expect(html).toContain(
        'aria-label="gemini: Runner not ready: needs key"',
      );
      // Trigger references the popover, and the popover carries the matching id.
      expect(html).toContain('aria-describedby="runners-readiness-tip-gemini"');
      expect(html).toContain('id="runners-readiness-tip-gemini"');
      expect(html).toContain('role="tooltip"');
    }
  });

  it("keeps the popover out of the a11y tree when closed (invisible, not just opacity-0)", () => {
    const html = render({
      isAdmin: true,
      adapters: [summary({ runners: [dto()] })],
    });

    // `invisible` removes the hidden tooltip from the accessibility tree;
    // `group-hover`/`group-focus-within` flip it back to `visible`.
    expect(html).toContain("invisible");
    expect(html).toContain("group-hover/runner:visible");
    expect(html).toContain("group-focus-within/runner:visible");
  });
});
