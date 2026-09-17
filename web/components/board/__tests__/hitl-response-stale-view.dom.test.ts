// @vitest-environment jsdom
//
// A refused HITL response must re-sync the rendered view. The respond route
// answers 409 CONFLICT for causes that mean the card on screen is stale (the
// run left NeedsInput, the row was superseded, a prompt-owner invariant no
// longer holds) — none of which the client can resolve by keeping the same
// buttons live. Without a refresh the operator is left clicking a dead card.
// A retryable or validation refusal is the opposite case: the view is current
// and the entered payload must survive, so it must NOT refresh.

import type { Root } from "react-dom/client";

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { router } = vi.hoisted(() => ({
  router: { refresh: vi.fn(), push: vi.fn() },
}));

vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("next-intl", () => ({
  useTranslations: (namespace: string) => (key: string) =>
    `${namespace}.${key}`,
}));

import { HitlActions } from "@/components/board/hitl-actions";
import { RunHitlResponse } from "@/components/board/run-hitl-response";

const PERMISSION_OPTIONS = [
  { optionId: "allow-once", label: "allow-once" },
  { optionId: "allow-with-updates", label: "allow-with-updates" },
  { optionId: "reject", label: "reject" },
];

let root: Root;
let container: HTMLDivElement;

function respondsWith(status: number, code: string): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Promise.resolve(
        new Response(JSON.stringify({ code, message: code }), {
          status,
          headers: { "content-type": "application/json" },
        }),
      ),
    ),
  );
}

async function clickOption(label: string): Promise<void> {
  const button = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === label,
  );

  expect(button).toBeDefined();
  await act(async () => {
    button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function renderRunHitlResponse(): void {
  act(() =>
    root.render(
      createElement(RunHitlResponse, {
        runId: "run-1",
        hitlRequestId: "hitl-1",
        kind: "permission",
        options: PERMISSION_OPTIONS,
        schema: null,
        canAct: true,
      }),
    ),
  );
}

function renderHitlActions(): void {
  act(() =>
    root.render(
      createElement(HitlActions, {
        runId: "run-1",
        hitlRequestId: "hitl-1",
        kind: "permission",
        options: PERMISSION_OPTIONS,
        canAct: true,
        snoozeLabel: "snooze",
        reviewLabel: "review",
      }),
    ),
  );
}

describe("RunHitlResponse — stale-view re-sync on a refused response", () => {
  it("refreshes the run view when the answer is refused as CONFLICT", async () => {
    respondsWith(409, "CONFLICT");
    renderRunHitlResponse();
    await clickOption("allow-with-updates");

    expect(router.refresh).toHaveBeenCalled();
    expect(container.textContent).toContain("run.error.CONFLICT");
  });

  it("refreshes when the request is gone (PRECONDITION)", async () => {
    respondsWith(409, "PRECONDITION");
    renderRunHitlResponse();
    await clickOption("allow-once");

    expect(router.refresh).toHaveBeenCalled();
  });

  it("refreshes when the permission window expired (HITL_TIMEOUT)", async () => {
    respondsWith(410, "HITL_TIMEOUT");
    renderRunHitlResponse();
    await clickOption("reject");

    expect(router.refresh).toHaveBeenCalled();
  });

  it("keeps the current view for a retryable supervisor outage", async () => {
    respondsWith(503, "EXECUTOR_UNAVAILABLE");
    renderRunHitlResponse();
    await clickOption("allow-once");

    expect(router.refresh).not.toHaveBeenCalled();
    expect(container.textContent).toContain("run.error.EXECUTOR_UNAVAILABLE");
  });

  it("keeps the current view for an incomplete answer", async () => {
    respondsWith(422, "NEEDS_INPUT");
    renderRunHitlResponse();
    await clickOption("allow-once");

    expect(router.refresh).not.toHaveBeenCalled();
  });
});

describe("HitlActions — stale-view re-sync on a refused response", () => {
  it("refreshes the board card when the answer is refused as CONFLICT", async () => {
    respondsWith(409, "CONFLICT");
    renderHitlActions();
    await clickOption("allow-with-updates");

    expect(router.refresh).toHaveBeenCalled();
    expect(container.textContent).toContain("apiErrors.CONFLICT");
  });

  it("keeps the board card for a retryable supervisor outage", async () => {
    respondsWith(503, "EXECUTOR_UNAVAILABLE");
    renderHitlActions();
    await clickOption("allow-once");

    expect(router.refresh).not.toHaveBeenCalled();
  });
});
