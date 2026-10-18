// @vitest-environment jsdom

import type { Root } from "react-dom/client";

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const router = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn() }));

vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("next-intl", () => ({
  useTranslations: (namespace: string) => (key: string) =>
    `${namespace}.${key}`,
}));

import { RunHitlResponse } from "@/components/board/run-hitl-response";

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  router.refresh.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("RunHitlResponse progress feedback", () => {
  it("shows immediate and long-running feedback while a decision is pending", async () => {
    let finish!: (response: Response) => void;

    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            finish = resolve;
          }),
      ),
    );

    act(() => {
      root.render(
        createElement(RunHitlResponse, {
          runId: "run-1",
          hitlRequestId: "hitl-1",
          kind: "permission",
          answerState: "open",
          storedResponse: null,
          options: [
            { optionId: "allow", label: "Allow" },
            { optionId: "deny", label: "Deny" },
          ],
          schema: null,
          canAct: true,
        }),
      );
    });

    const allow = [...host.querySelectorAll("button")].find(
      (button) => button.textContent === "Allow",
    );

    if (!allow) throw new Error("missing Allow button");

    await act(async () => allow.click());

    expect(
      host.querySelector("[aria-busy=true]")?.getAttribute("aria-busy"),
    ).toBe("true");
    expect(
      host.querySelector("[data-testid=hitl-response-in-progress]")
        ?.textContent,
    ).toContain("run.hitlResponseInProgress");
    expect(allow.disabled).toBe(true);

    await act(async () => vi.advanceTimersByTimeAsync(8_000));
    expect(
      host.querySelector("[data-testid=hitl-response-in-progress]")
        ?.textContent,
    ).toContain("run.operationTakingLonger");

    await act(async () =>
      finish(Response.json({ state: "resume-queued" }, { status: 202 })),
    );
    expect(router.refresh).toHaveBeenCalledOnce();
  });
});
