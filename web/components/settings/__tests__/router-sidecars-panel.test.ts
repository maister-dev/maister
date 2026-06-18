import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { RouterSidecarsPanel } from "@/components/settings/router-sidecars-panel";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

describe("RouterSidecarsPanel", () => {
  it("renders sidecar readiness details and refresh action without raw secrets", () => {
    const html = renderToStaticMarkup(
      createElement(RouterSidecarsPanel, {
        sidecars: [
          {
            id: "ccr-default",
            kind: "ccr",
            lifecycle: "managed",
            commandPreset: "ccr_start",
            configPath: "~/.claude-code-router/config.json",
            baseUrl: "http://127.0.0.1:3456",
            healthcheckUrl: "http://127.0.0.1:3456/health",
            authTokenRef: "env:MAISTER_CCR_AUTH_TOKEN",
            readinessStatus: "NotReady",
            readinessReasons: ["sidecar ccr-default is not ready: idle"],
            enabled: true,
          },
        ],
      }),
    );

    expect(html).toContain("ccr-default");
    expect(html).toContain("managed");
    expect(html).toContain("NotReady");
    expect(html).toContain("sidecar ccr-default is not ready: idle");
    expect(html).toContain("env:MAISTER_CCR_AUTH_TOKEN");
    expect(html).toContain("refresh");
    expect(html).not.toContain("raw-token");
    // With no live process state the dot is muted and Start is offered.
    expect(html).toContain("bg-mute");
    expect(html).toContain("sidecarStart");
  });

  it("shows a Stop action and a good-tone dot when the process state is ready", () => {
    const html = renderToStaticMarkup(
      createElement(RouterSidecarsPanel, {
        processStateById: { "ccr-default": "ready" },
        sidecars: [
          {
            id: "ccr-default",
            kind: "ccr",
            lifecycle: "managed",
            commandPreset: "ccr_start",
            configPath: "~/.claude-code-router/config.json",
            baseUrl: "http://127.0.0.1:3456",
            healthcheckUrl: "http://127.0.0.1:3456/health",
            authTokenRef: "env:MAISTER_CCR_AUTH_TOKEN",
            readinessStatus: "Ready",
            readinessReasons: [],
            enabled: true,
          },
        ],
      }),
    );

    expect(html).toContain("bg-good");
    expect(html).toContain("sidecarStop");
    expect(html).not.toContain("sidecarStart");
  });
});
