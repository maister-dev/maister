// @vitest-environment jsdom

import type { Root } from "react-dom/client";
import type { TerminalCause } from "@/lib/domain-events/taxonomy";
import type {
  ScratchDetail,
  ScratchDialogStatus,
} from "@/lib/scratch-runs/dialog";
import type { ComponentType, ReactNode } from "react";

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ScratchConversation } from "@/components/scratch/scratch-conversation";
import en from "@/messages/en.json";

// ADR-182: what the scratch dialog tells the operator about a message sent
// while the agent was busy — the transcript badge and the composer notice —
// and, since the ownership residuals (D-A2), why a Recover was refused.

const TestIntlProvider = NextIntlClientProvider as ComponentType<{
  locale: string;
  messages: typeof en;
  children?: ReactNode;
}>;

const { stream } = vi.hoisted(() => ({ stream: { eventCount: 0 } }));

vi.mock("@/lib/use-run-stream", () => ({
  useRunStream: () => ({ eventCount: stream.eventCount }),
}));
vi.mock("@/components/scratch/scratch-composer", () => ({
  ScratchComposer: (props: {
    deliveryNotice: string | null;
    onRecover: (prompt: string) => Promise<boolean>;
    onSend: (payload: {
      content: string;
      attachments: never[];
      files: never[];
    }) => Promise<boolean>;
  }) =>
    createElement(
      "div",
      null,
      createElement(
        "output",
        { "data-testid": "notice" },
        props.deliveryNotice ?? "",
      ),
      createElement(
        "button",
        {
          type: "button",
          onClick: () =>
            void props.onSend({
              content: "also X",
              attachments: [],
              files: [],
            }),
        },
        "send",
      ),
      createElement(
        "button",
        {
          type: "button",
          onClick: () => void props.onRecover("go on"),
        },
        "recover",
      ),
    ),
}));

let root: Root;
let container: HTMLDivElement;
let dialogStatus: ScratchDialogStatus;
let runStatus: string;
let recoverRefusal: string | null;
let terminalCause: TerminalCause | null;

function detail(): ScratchDetail {
  return {
    run: {
      id: "run-1",
      projectSlug: "p",
      capabilityAgent: "claude",
      runnerSnapshot: null,
      createdByDisplayName: "Operator",
      status: runStatus,
    },
    scratch: { dialogStatus },
    messages: [
      {
        id: "m-1",
        runId: "run-1",
        sequence: 1,
        role: "user",
        content: "also X",
        createdAt: "2026-09-26T10:00:00.000Z",
        delivery: "queued",
      },
    ],
    attachments: [],
    workspace: null,
    capabilityProfile: null,
    pendingHitl: null,
    terminalCause,
  } as unknown as ScratchDetail;
}

async function render(): Promise<void> {
  await act(async () => {
    root.render(
      createElement(
        TestIntlProvider,
        { locale: "en", messages: en },
        createElement(ScratchConversation, { runId: "run-1", canAct: true }),
      ),
    );
  });
}

// A stream event makes the conversation reload its detail (debounced 250 ms).
async function refresh(
  status: ScratchDialogStatus,
  run = "Running",
): Promise<void> {
  dialogStatus = status;
  runStatus = run;
  stream.eventCount += 1;
  await render();
  await act(async () => {
    vi.advanceTimersByTime(250);
  });
  await act(async () => {});
}

function badge(): string | null {
  return (
    container.querySelector('[data-testid="scratch-delivery-badge"]')
      ?.textContent ?? null
  );
}

function notice(): string {
  return (
    container.querySelector('[data-testid="notice"]')?.textContent ?? "missing"
  );
}

beforeEach(() => {
  stream.eventCount = 0;
  dialogStatus = "Running";
  runStatus = "Running";
  recoverRefusal = null;
  terminalCause = null;
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) =>
      init?.method === "POST" && url.endsWith("/messages")
        ? new Response(
            JSON.stringify({
              messageId: "m-2",
              sequence: 2,
              dialogStatus: "Running",
              delivery: "queued",
            }),
            { status: 202 },
          )
        : init?.method === "POST" && url.endsWith("/recover")
          ? new Response(
              JSON.stringify({
                code: "CONFLICT",
                message: "scratch run is not recoverable",
                details: {
                  reason: "scratch_not_recoverable",
                  status: recoverRefusal,
                  ...(recoverRefusal === "NeedsInputIdle"
                    ? { next: "respond" }
                    : {}),
                },
              }),
              { status: 409 },
            )
          : new Response(JSON.stringify(detail()), { status: 200 }),
    ),
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("scratch delivery feedback (ADR-182)", () => {
  it("a queued row reads Queued while it can still be sent and Not sent once the dialog ended", async () => {
    await render();
    await act(async () => {});
    expect(badge()).toBe(en.scratch.deliveryQueuedBadge);

    // Recover resumes a crashed dialog, which then sends the queued row.
    await refresh("Crashed");
    expect(badge()).toBe(en.scratch.deliveryQueuedBadge);

    for (const ended of ["Review", "Abandoned", "Done"] as const) {
      await refresh(ended);
      expect(badge(), ended).toBe(en.scratch.deliveryNotSentBadge);
    }
    // A budget stop leaves the dialog `Crashed` over a `Failed` run, which
    // Recover refuses: nothing will ever send the row.
    await refresh("Crashed", "Failed");
    expect(badge()).toBe(en.scratch.deliveryNotSentBadge);
  });

  it.each([
    ["Failed", en.scratch.recoverRefused.Failed],
    ["NeedsInputIdle", en.scratch.recoverRefused.NeedsInputIdle],
    ["Running", en.scratch.recoverRefused.Live],
  ])(
    "a Recover refused for a %s run names why instead of a generic error",
    async (status, text) => {
      recoverRefusal = status;
      dialogStatus = "Crashed";
      runStatus = "Crashed";
      await render();
      await act(async () => {});
      await act(async () => {
        [...container.querySelectorAll("button")]
          .find((button) => button.textContent === "recover")
          ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await Promise.resolve();
      });
      await act(async () => {});
      expect(
        container.querySelector('[role="alert"]')?.textContent ?? null,
      ).toBe(text);
    },
  );

  // B6 (ADR-177 amendment): the ended dialog says why, and a budget kill says
  // it cannot be recovered instead of offering a resume.
  it("the Crashed and Failed hints carry the run's terminal cause", async () => {
    const causeLine = () =>
      container.querySelector('[data-testid="terminal-cause-notice"]')
        ?.textContent ?? null;

    dialogStatus = "Crashed";
    runStatus = "Crashed";
    terminalCause = {
      code: "CRASH",
      reason: "agent_session_gone",
      source: "scratch",
    };
    await render();
    await act(async () => {});
    expect(container.textContent).toContain(en.scratch.recoverHint);
    expect(causeLine()).toContain(
      en.run.terminalCause.reasons.agent_session_gone,
    );

    terminalCause = {
      code: "BUDGET_EXCEEDED",
      reason: "budget_breach",
      source: "scratch",
    };
    await refresh("Crashed", "Failed");
    expect(container.textContent).toContain(en.scratch.recoverRefused.Failed);
    expect(container.textContent).not.toContain(en.scratch.recoverHint);
    // The reason's copy leads; the code's stands in only when it has none.
    expect(causeLine()).toContain(en.run.terminalCause.reasons.budget_breach);
    expect(causeLine()).not.toContain(en.run.failure.codes.BUDGET_EXCEEDED);
  });

  it("a delivery notice ends with its turn and is not revived by the next dispatched turn", async () => {
    await render();
    await act(async () => {});
    await act(async () => {
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "send")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    await act(async () => {});
    expect(notice()).toBe("queued");

    await refresh("WaitingForUser");
    expect(notice()).toBe("");
    // The queued message is dispatched: a new turn, not the one the notice
    // described.
    await refresh("Running");
    expect(notice()).toBe("");
  });
});
