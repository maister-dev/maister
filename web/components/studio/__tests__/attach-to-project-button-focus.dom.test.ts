// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const locale = vi.hoisted(() => ({ value: "en" }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock("next-intl", () => ({
  useTranslations: (namespace: string) => (key: string) => {
    if (namespace === "apiErrors" && key === "CONFIG") {
      return locale.value === "ru" ? "Некорректные данные" : "Invalid input";
    }

    return key;
  },
}));

import { AttachToProjectButton } from "@/components/studio/attach-to-project-button";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe("AttachToProjectButton focus contract", () => {
  it.each([
    ["en", "Invalid input"],
    ["ru", "Некорректные данные"],
  ])(
    "moves focus to the typed %s CONFIG alert when an attach request fails",
    async (language, errorLabel) => {
      locale.value = language;
      const container = document.createElement("div");

      document.body.append(container);
      const root = createRoot(container);
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          new Response(
            JSON.stringify({ code: "CONFIG", message: "cannot attach" }),
            {
              headers: { "content-type": "application/json" },
              status: 422,
            },
          ),
        ),
      );

      await act(async () => {
        root.render(
          createElement(AttachToProjectButton, {
            compatibility: { compatible: true, incompatibilityReason: null },
            defaultOpen: true,
            installId: "inst-1",
            triggerClassName: "x",
            targets: [{ slug: "beta", name: "Beta", attached: false }],
          } as never),
        );
      });

      const attach = container.querySelector<HTMLButtonElement>(
        '[data-testid="attach-do-beta"]',
      );

      await act(async () => attach?.click());

      const alert = container.querySelector('[data-testid="attach-error"]');
      const retainedAction = container.querySelector<HTMLButtonElement>(
        '[data-testid="attach-do-beta"]',
      );

      expect(alert?.getAttribute("tabindex")).toBe("-1");
      expect(alert?.textContent).toContain(errorLabel);
      expect(document.activeElement).toBe(alert);
      expect(retainedAction?.disabled).toBe(false);

      await act(async () => root.unmount());
    },
  );
});
