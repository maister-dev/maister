// @vitest-environment jsdom

// ADR-181: a recover refused because a workbench operation owns the worktree is
// the one retryable 409. Every other 409 tells the operator to discard the
// workspace — advice that, shown for `busy`, would destroy the work the git
// operation is preserving. The banner branches on the typed `details.reason`.

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
  useTranslations: (namespace: string) => (key: string) =>
    `${namespace}.${key}`,
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/components/feedback/feedback-provider", () => ({
  useFeedback: () => ({ success: vi.fn(), error: vi.fn() }),
}));

import { RunRecoverActions } from "@/components/runs/run-recover-actions";

const fetchMock = vi.fn<typeof fetch>();
let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", fetchMock);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

async function recoverAnswered(body: unknown): Promise<string> {
  fetchMock.mockResolvedValueOnce(Response.json(body, { status: 409 }));
  act(() =>
    root.render(
      createElement(RunRecoverActions, { runId: "run-1", canRecover: true }),
    ),
  );
  act(() =>
    (
      document.querySelector('[data-testid="recover-button"]') as HTMLElement
    ).click(),
  );
  await act(async () => {
    (
      document.querySelector(
        '[data-testid="recover-confirm-submit"]',
      ) as HTMLElement
    ).click();
  });

  expect(fetchMock).toHaveBeenCalledWith(
    "/api/runs/run-1/recover",
    expect.objectContaining({ method: "POST" }),
  );

  return document.querySelector('[role="alert"]')?.textContent ?? "";
}

describe("RunRecoverActions — a refused recover", () => {
  it("names a busy worktree as retryable, never as a discard", async () => {
    const text = await recoverAnswered({
      code: "CONFLICT",
      message: "a workbench operation owns the run's worktree",
      details: { reason: "busy" },
    });

    expect(text).toBe("run.recoverBusy");
  });

  it("keeps the discard advice for every other refusal", async () => {
    const text = await recoverAnswered({
      code: "CONFLICT",
      message: "run is not in Crashed",
      details: { reason: "recover_cas_lost" },
    });

    expect(text).toBe("run.recoverConflict");
  });
});
