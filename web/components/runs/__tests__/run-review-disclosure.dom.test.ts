// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const query = vi.hoisted(() => ({ value: "" }));

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(query.value),
}));

import { RunReviewDisclosure } from "@/components/runs/run-review-disclosure";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const roots: ReturnType<typeof createRoot>[] = [];

afterEach(() => {
  act(() => roots.splice(0).forEach((root) => root.unmount()));
  document.body.innerHTML = "";
  query.value = "";
});

function render(advanced = false, collapsed = true) {
  const container = document.createElement("div");
  const root = createRoot(container);

  document.body.append(container);
  roots.push(root);
  const draw = () =>
    act(() =>
      root.render(
        createElement(
          RunReviewDisclosure,
          {
            advanced,
            collapsed,
            label: "Advanced",
          },
          "Workspace operations",
        ),
      ),
    );

  draw();

  return { container, draw };
}

describe("review disclosures", () => {
  it("keeps technical history and workspace operations collapsed on arrival", () => {
    const { container } = render(true);

    expect(container.querySelector("details")?.open).toBe(false);
  });

  it("opens Advanced for an operation deep link, including same-page navigation", () => {
    const { container, draw } = render(true);

    query.value = "git=update";
    draw();
    expect(container.querySelector("details")?.open).toBe(true);
  });

  it("does not expand technical history when opening workspace operations", () => {
    query.value = "git=update";
    const { container } = render();

    expect(container.querySelector("details")?.open).toBe(false);
  });

  it("leaves non-review content directly accessible", () => {
    const { container } = render(false, false);

    expect(container.querySelector("details")).toBeNull();
    expect(container.textContent).toBe("Workspace operations");
  });
});
