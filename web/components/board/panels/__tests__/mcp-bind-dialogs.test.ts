import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
  useTranslations:
    () =>
    (key: string, vars?: Record<string, unknown>): string =>
      vars ? `${key}:${JSON.stringify(vars)}` : key,
}));

import {
  MatchDialog,
  OverlayDialog,
} from "@/components/board/panels/mcp-bind-dialogs";
import { type McpBindingView } from "@/components/board/panels/mcp-panel";

describe("MatchDialog (W-D, T6.2)", () => {
  it("renders platform + project candidates, warns on untrusted, and offers a bind confirm", () => {
    const markup = renderToStaticMarkup(
      createElement(MatchDialog, {
        slug: "proj",
        refId: "github",
        candidates: [
          {
            targetKind: "platform",
            targetId: "github",
            transport: "stdio",
            trust: "untrusted",
          },
          { targetKind: "project", targetId: "row-1", transport: "stdio" },
        ],
        onClose: vi.fn(),
        onDone: vi.fn(),
      }),
    );

    expect(markup).toContain('data-testid="mcp-match-candidate-platform"');
    expect(markup).toContain('data-testid="mcp-match-candidate-project"');
    expect(markup).toContain('data-testid="mcp-match-confirm"');
    // An untrusted platform candidate is offered but flagged (trusted-or-warned).
    expect(markup).toContain("matchUntrustedWarn");
  });

  it("shows the no-candidates message when nothing matches", () => {
    const markup = renderToStaticMarkup(
      createElement(MatchDialog, {
        slug: "proj",
        refId: "github",
        candidates: [],
        onClose: vi.fn(),
        onDone: vi.fn(),
      }),
    );

    expect(markup).toContain("matchNoCandidates");
  });
});

describe("OverlayDialog (W-C, T6.2)", () => {
  it("seeds the env-remap editor from the binding overlay (NAMES only)", () => {
    const binding: McpBindingView = {
      refId: "github",
      targetKind: "platform",
      targetId: "github",
      enabled: true,
      configOverlay: { envRemap: { GITHUB_TOKEN: "env:PROJ_A_TOKEN" } },
      recommendedHint: null,
    };
    const markup = renderToStaticMarkup(
      createElement(OverlayDialog, {
        slug: "proj",
        binding,
        slots: { env: ["GITHUB_TOKEN"], header: [] },
        onClose: vi.fn(),
        onDone: vi.fn(),
      }),
    );

    expect(markup).toContain("overlayEnvRemap");
    expect(markup).toContain("GITHUB_TOKEN");
    // The overlay carries an env:NAME reference, never a raw secret value.
    expect(markup).toContain("env:PROJ_A_TOKEN");
    expect(markup).toContain('data-testid="mcp-overlay-save"');
  });
});
