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
import type { ReactElement } from "react";

import { act, createElement, useState } from "react";
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
        answerState: "open",
        storedResponse: null,
        options: PERMISSION_OPTIONS,
        schema: null,
        canAct: true,
      }),
    ),
  );
}

describe("RunHitlResponse — stale-view re-sync on a refused response", () => {
  it.each([false, true])(
    "keeps a closed enum selection clearable only when required=%s permits it",
    async (required) => {
      const fetch = vi.fn(async () => Response.json({ ok: true }));

      vi.stubGlobal("fetch", fetch);
      act(() =>
        root.render(
          createElement(RunHitlResponse, {
            runId: "run-form",
            hitlRequestId: "form-1",
            kind: "form",
            answerState: "open",
            storedResponse: null,
            options: [],
            schema: {
              schemaVersion: 1,
              fields: [
                {
                  name: "scope",
                  type: "enum",
                  required,
                  options: ["sort-first", "manual-rank"],
                },
              ],
            },
            canAct: true,
          }),
        ),
      );
      expect(container.querySelector("input")).toBeNull();
      await clickOption("sort-first");
      await clickOption("sort-first");
      const option = [...container.querySelectorAll("button")].find(
        (button) => button.textContent === "sort-first",
      );

      expect(option?.getAttribute("aria-pressed")).toBe(String(required));
      await clickOption("run.submit");
      expect(fetch).toHaveBeenCalledWith(
        "/api/runs/run-form/hitl/form-1/respond",
        expect.objectContaining({
          body: JSON.stringify({
            response: required ? { scope: "sort-first" } : {},
          }),
        }),
      );
    },
  );

  it("submits a custom clarification answer and closes its parent card on success", async () => {
    const answer =
      "Нужно доработать доску: конфигурировать фильтры и сортировку прямо на доске с разными параметрами.";
    const fetch = vi.fn(async () =>
      Response.json({ ok: true, runStatus: "Done" }),
    );

    vi.stubGlobal("fetch", fetch);
    function QuestionCard(): ReactElement {
      const [answered, setAnswered] = useState(false);

      return answered
        ? createElement("p", null, "Answer recorded")
        : createElement(RunHitlResponse, {
            runId: "run-question",
            hitlRequestId: "question-1",
            kind: "agent_question",
            answerState: "open",
            storedResponse: null,
            options: [],
            schema: {
              schemaVersion: 1,
              fields: [
                {
                  name: "scope",
                  type: "enum",
                  required: true,
                  options: ["sort-first", "manual-rank"],
                },
                { name: "notes", type: "string", required: false },
              ],
            },
            canAct: true,
            onRespond: () => setAnswered(true),
          });
    }

    act(() => root.render(createElement(QuestionCard)));
    const field = container.querySelector<HTMLInputElement>(
      "#hitl-form-field-scope",
    );

    expect(field).not.toBeNull();
    const setValue = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set;

    await act(async () => {
      setValue?.call(field, answer);
      field?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await clickOption("run.answerClarification");

    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith(
      "/api/runs/run-question/hitl/question-1/respond",
      expect.objectContaining({
        body: JSON.stringify({ response: { scope: answer } }),
      }),
    );
    expect(container.textContent).toBe("Answer recorded");
    expect(container.querySelector("input")).toBeNull();
    expect(container.textContent).not.toContain("run.error.NEEDS_INPUT");
  });

  it("refreshes the run view when the answer is refused as CONFLICT", async () => {
    respondsWith(409, "CONFLICT");
    renderRunHitlResponse();
    await clickOption("run.permissionAllowWithUpdates");

    expect(router.refresh).toHaveBeenCalled();
    expect(container.textContent).toContain("run.error.CONFLICT");
  });

  it("refreshes when the request is gone (PRECONDITION)", async () => {
    respondsWith(409, "PRECONDITION");
    renderRunHitlResponse();
    await clickOption("run.permissionAllowOnce");

    expect(router.refresh).toHaveBeenCalled();
  });

  it("refreshes when the permission window expired (HITL_TIMEOUT)", async () => {
    respondsWith(410, "HITL_TIMEOUT");
    renderRunHitlResponse();
    await clickOption("run.permissionReject");

    expect(router.refresh).toHaveBeenCalled();
  });

  it("keeps the current view for a retryable supervisor outage", async () => {
    respondsWith(503, "EXECUTOR_UNAVAILABLE");
    renderRunHitlResponse();
    await clickOption("run.permissionAllowOnce");

    expect(router.refresh).not.toHaveBeenCalled();
    expect(container.textContent).toContain("run.error.EXECUTOR_UNAVAILABLE");
  });

  it("keeps the current view for an incomplete answer", async () => {
    respondsWith(422, "NEEDS_INPUT");
    renderRunHitlResponse();
    await clickOption("run.permissionAllowOnce");

    expect(router.refresh).not.toHaveBeenCalled();
  });
});
