// @vitest-environment jsdom

import type { Root } from "react-dom/client";
import type { PlatformStatus } from "@/types/platform-status";

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AttentionLiveRefresh } from "@/components/attention/attention-live-refresh";
import { StatusBar } from "@/components/chrome/status-bar";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
}));
vi.mock("next-intl/server", () => ({
  getTranslations: async (namespace: string) => (key: string) =>
    `${namespace}.${key}`,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

const platformStatus: PlatformStatus = {
  kind: "unavailable",
  reason: "network",
  message: "Supervisor unavailable",
};
const eventSource = vi.fn(function () {
  return { addEventListener: vi.fn(), close: vi.fn() };
});

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("EventSource", eventSource);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("status bar stream ownership", () => {
  it("renders auth status without opening an authenticated stream", async () => {
    const footer = await StatusBar({ platformStatus, summary: "Sign in" });

    act(() => root.render(footer));
    expect(container.textContent).toContain("Sign in");
    expect(
      container.querySelector('[data-testid="run-stream-liveness"]'),
    ).toBeNull();
    expect(eventSource).not.toHaveBeenCalled();
  });

  it("mounts the app layout's supplied attention status", async () => {
    const footer = await StatusBar({
      platformStatus,
      liveStatus: createElement(AttentionLiveRefresh, {
        labels: {
          disconnected: "Disconnected",
          live: "Live",
          reconnect: "Reconnect",
          reconnecting: "Reconnecting",
        },
      }),
    });

    act(() => root.render(footer));
    expect(
      container.querySelector('[data-testid="run-stream-liveness"]')
        ?.textContent,
    ).toBe("Reconnecting");
    expect(eventSource).toHaveBeenCalledOnce();
    expect(eventSource).toHaveBeenCalledWith(
      "http://localhost:3000/api/attention/stream",
    );
  });
});
