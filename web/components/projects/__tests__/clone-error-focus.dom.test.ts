// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

import { CloneErrorBlock } from "@/components/projects/new-project-form";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

afterEach(() => {
  document.body.replaceChildren();
});

describe("CloneErrorBlock focus contract", () => {
  it("moves focus to the typed alert when an error appears", async () => {
    const container = document.createElement("div");

    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        createElement(CloneErrorBlock, {
          cloneDetail: undefined,
          cloneReason: undefined,
          errorCode: "CONFIG",
          repoUrl: "",
        }),
      );
    });

    const alert = container.querySelector('[role="alert"]');

    expect(alert).not.toBeNull();
    expect(alert?.getAttribute("tabindex")).toBe("-1");
    expect(document.activeElement).toBe(alert);

    await act(async () => root.unmount());
  });
});
