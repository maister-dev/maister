// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

import { NodeInterruptTrigger } from "@/components/runs/node-interrupt-trigger";

const refresh = vi.hoisted(() => vi.fn());

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

it("disables the active request and refreshes only after the server accepts it", async () => {
  const response = Promise.withResolvers<Response>();
  const request = vi.fn(() => response.promise);
  const host = document.createElement("div");

  document.body.append(host);
  const root = createRoot(host);

  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", request);
  try {
    await act(() =>
      root.render(
        createElement(NodeInterruptTrigger, { runId: "r", canAct: true }),
      ),
    );
    const stop = host.querySelector<HTMLButtonElement>(
      'button[aria-label="interruptNode"]',
    )!;

    await act(() => stop.click());
    expect(stop.disabled).toBe(true);
    await act(() => stop.click());
    expect(request).toHaveBeenCalledTimes(1);
    expect(refresh).not.toHaveBeenCalled();
    await act(async () =>
      response.resolve(new Response(null, { status: 202 })),
    );
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(stop.disabled).toBe(false);
  } finally {
    await act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
