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
  it("previews the specific current budget restart request before its destructive confirmation and submits that exact witness", async () => {
    const request = {
      taskId: "task-1",
      expectedTaskRevision: 4,
      expectedSettingsToken: "shown-settings",
      relaunchOfRunId: "run-1",
      flowId: "flow-1",
      runnerId: "runner-1",
      deliveryPolicy: {
        strategy: "pull_request",
        push: "on_success",
        trigger: "auto_on_ready",
        targetBranch: "main",
      },
    };
    const transport = vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === "POST"
        ? Response.json(
            { ok: true, state: "restart_queued", intentId: "intent-1" },
            { status: 202 },
          )
        : Response.json({
            request,
            title: "Current task title",
            prompt: "Current request shown to the user",
            flowName: "Delivery Flow",
            runnerLabel: "codex · model",
            targetRevision: "v1",
            settings: {
              deliveryPolicy: request.deliveryPolicy,
              executionPolicy: { preset: "supervised", overrides: {} },
              autoPromote: true,
              brainContext: null,
              targetBranch: "main",
              workspace: "worktree",
            },
          }),
    );

    vi.stubGlobal("fetch", transport);
    act(() =>
      root.render(
        createElement(RunHitlResponse, {
          runId: "run-1",
          hitlRequestId: "hitl-1",
          kind: "budget_breach",
          claimStage: null,
          answerState: "open",
          storedResponse: null,
          canAct: true,
          options: [],
          availableOptions: [
            {
              optionId: "restart",
              label: "Restart",
              helperText: "",
              destructive: true,
              dropAllowed: false,
              requiresBranchName: false,
              modes: [],
            },
          ],
          schema: {
            kind: "budget_breach",
            scope: "run",
            meter: "tokens",
            current: 120,
            limit: 100,
            decisions: ["raise", "abandon"],
          },
        }),
      ),
    );
    const restart = host.querySelector<HTMLButtonElement>(
      "[data-testid=budget-breach-restart]",
    );

    if (!restart) throw new Error("Missing budget Restart action");
    await act(async () => restart.click());
    expect(transport).toHaveBeenCalledOnce();
    expect(transport.mock.calls[0][0]).toContain("/restart-preview");
    const dialog = document.querySelector(
      "[data-testid=budget-restart-preview]",
    );

    expect(dialog?.textContent).toContain("Current request shown to the user");
    expect(dialog?.textContent).toContain("Delivery Flow");
    expect(dialog?.textContent).toContain("codex · model");
    const confirm = dialog?.querySelector<HTMLButtonElement>(
      "[data-testid=budget-restart-preview-confirm]",
    );

    if (!confirm) throw new Error("Missing restart confirmation");
    await act(async () => confirm.click());
    expect(transport).toHaveBeenCalledTimes(2);
    expect(JSON.parse(transport.mock.calls[1][1]?.body as string)).toEqual({
      optionId: "restart",
      restartLaunch: request,
    });
  });

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
