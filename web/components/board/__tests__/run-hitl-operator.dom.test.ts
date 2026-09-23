// @vitest-environment jsdom

import type { Root } from "react-dom/client";
import type { HitlItem } from "@/lib/queries/hitl";
import type { ComponentType, ReactNode } from "react";

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RunHitlResponse } from "@/components/board/run-hitl-response";
import { HitlPanel } from "@/components/inbox/hitl-panel";
import en from "@/messages/en.json";
import ru from "@/messages/ru.json";

const TestIntlProvider = NextIntlClientProvider as ComponentType<{
  locale: string;
  messages: typeof en;
  children?: ReactNode;
}>;

const { router, feedbackError } = vi.hoisted(() => ({
  router: { refresh: vi.fn(), push: vi.fn() },
  feedbackError: vi.fn(),
}));

vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("@/components/feedback/feedback-provider", () => ({
  useOptionalFeedback: () => ({ error: feedbackError, success: vi.fn() }),
}));

const cases = [
  ["CONFLICT", "permission_resume_in_flight"],
  ["CONFLICT", "assignment_fenced"],
  ["PRECONDITION", "prompt_owner_deferred"],
  ["CONFLICT", "prompt_owner_invariant"],
  ["CONFLICT", "already_delivered"],
  ["CONFLICT", "option_mismatch"],
  ["CONFLICT", "not_awaiting_input"],
  ["HITL_TIMEOUT", "agent_session_ended"],
  ["HITL_TIMEOUT", "permission_delivery_rejected"],
  ["EXECUTOR_UNAVAILABLE", "delivery_unavailable"],
] as const;

let root: Root;
let container: HTMLDivElement;

function render(
  locale: "en" | "ru",
  props: Partial<Parameters<typeof RunHitlResponse>[0]> = {},
): void {
  const messages = locale === "en" ? en : ru;

  act(() => {
    root.render(
      createElement(
        TestIntlProvider,
        { locale, messages },
        createElement(RunHitlResponse, {
          runId: "run-1",
          hitlRequestId: "hitl-1",
          kind: "permission",
          options: [
            { optionId: "allow", label: "Allow" },
            { optionId: "deny", label: "Deny" },
          ],
          schema: null,
          canAct: true,
          answerState: "open",
          storedResponse: null,
          ...props,
        }),
      ),
    );
  });
}

async function click(label: string): Promise<void> {
  const button = [...container.querySelectorAll("button")].find(
    (element) => element.textContent === label,
  );

  expect(button).toBeDefined();
  await act(async () => {
    button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  router.refresh.mockReset();
  feedbackError.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("RunHitlResponse operator reasons", () => {
  for (const locale of ["en", "ru"] as const) {
    for (const [code, reason] of cases) {
      it(`${locale}: renders ${code}/${reason} without a raw token`, async () => {
        vi.stubGlobal(
          "fetch",
          vi.fn(
            async () =>
              new Response(
                JSON.stringify({
                  code,
                  message: "raw server text",
                  details: { reason },
                }),
                {
                  status:
                    code === "HITL_TIMEOUT"
                      ? 410
                      : code === "EXECUTOR_UNAVAILABLE"
                        ? 503
                        : 409,
                },
              ),
          ),
        );
        render(locale);
        await click("Allow");

        const expected = (locale === "en" ? en : ru).run.errorReasons[reason];

        expect(container.textContent).toContain(expected);
        expect(container.textContent).not.toContain(reason);
        expect(container.textContent).not.toContain("raw server text");
      });
    }

    it(`${locale}: unknown reason uses the per-code line`, async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(
              JSON.stringify({
                code: "CONFLICT",
                details: { reason: "future_reason" },
              }),
              { status: 409 },
            ),
        ),
      );
      render(locale);
      await click("Allow");

      expect(container.textContent).toContain(
        (locale === "en" ? en : ru).run.error.CONFLICT,
      );
      expect(container.textContent).not.toContain("future_reason");
    });

    it(`${locale}: an unknown code or mismatched reason never exposes a token`, async () => {
      const responses = [
        { code: "FUTURE_CODE", details: { reason: "future_reason" } },
        { code: "CONFLICT", details: { reason: "agent_session_ended" } },
      ];

      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(JSON.stringify(responses.shift()), { status: 409 }),
        ),
      );
      render(locale);
      await click("Allow");
      expect(container.textContent).toContain(
        (locale === "en" ? en : ru).run.error.generic,
      );
      render(locale, { hitlRequestId: "hitl-2" });
      await click("Allow");
      expect(container.textContent).toContain(
        (locale === "en" ? en : ru).run.error.CONFLICT,
      );
      expect(container.textContent).not.toContain("agent_session_ended");
    });
  }

  it("retranslates a visible refusal when the locale changes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              code: "CONFLICT",
              details: { reason: "assignment_fenced" },
            }),
            { status: 409 },
          ),
      ),
    );
    render("en");
    await click("Allow");
    expect(container.textContent).toContain(
      en.run.errorReasons.assignment_fenced,
    );

    render("ru");
    expect(container.textContent).toContain(
      ru.run.errorReasons.assignment_fenced,
    );
    expect(container.textContent).not.toContain(
      en.run.errorReasons.assignment_fenced,
    );
  });
});

describe("RunHitlResponse stored answer", () => {
  it("locks choices after a 503 and retries the identical saved answer", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            code: "EXECUTOR_UNAVAILABLE",
            details: { reason: "delivery_unavailable" },
          }),
          { status: 503 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ ok: true, state: "resume-in-progress" }),
          {
            status: 202,
          },
        ),
      );

    vi.stubGlobal("fetch", fetchMock);
    render("en");
    await click("Allow");

    expect(
      container.querySelector('[data-testid="hitl-answer-stored"]'),
    ).not.toBeNull();
    expect(container.textContent).toContain(
      en.run.errorReasons.delivery_unavailable,
    );
    expect(container.textContent).not.toContain("Deny");
    await click(en.run.retryDelivery);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[1]?.body).toBe(
      fetchMock.mock.calls[0]?.[1]?.body,
    );
  });
  it("holds a 202 answer read-only through stale props and retries the same payload", async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(
          JSON.stringify({ ok: true, state: "resume-in-progress" }),
          { status: 202 },
        ),
    );
    const onRespond = vi.fn();

    vi.stubGlobal("fetch", fetchMock);
    render("en", { onRespond });
    await click("Allow");

    expect(container.textContent).toContain(en.run.answerSaved);
    expect(container.textContent).not.toContain("Deny");
    expect(onRespond).toHaveBeenCalledTimes(1);
    expect(document.activeElement?.textContent).toBe(en.run.retryDelivery);

    render("en", { onRespond, answerState: "open", storedResponse: null });
    expect(container.textContent).toContain(en.run.answerSaved);
    await click(en.run.retryDelivery);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      optionId: "allow",
    });

    render("en", { hitlRequestId: "hitl-2", onRespond });
    expect(container.textContent).toContain("Deny");
  });

  it("shows an authoritative stored choice to a read-only viewer", () => {
    render("en", {
      canAct: false,
      answerState: "answer_stored",
      storedResponse: { optionId: "deny" },
    });

    expect(container.textContent).toContain(en.run.answerSaved);
    expect(container.textContent).toContain("Deny");
    expect(container.textContent).not.toContain(en.run.retryDelivery);
  });

  it("retries a stored form with the complete public envelope unchanged", async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );

    vi.stubGlobal("fetch", fetchMock);
    const storedResponse = {
      response: { approved: true, confidence: 0 },
      confidence: 0,
    };

    render("en", {
      kind: "form",
      options: [],
      schema: { fields: [] },
      answerState: "answer_stored",
      storedResponse,
    });
    await click(en.run.retryDelivery);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual(
      storedResponse,
    );
  });

  it.each(["resume-in-progress", "delivery-in-progress"])(
    "keeps a %s reply read-only after a fresh remount from server DTO",
    async (state) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(JSON.stringify({ ok: true, state }), { status: 202 }),
        ),
      );
      render("en");
      await click("Allow");
      expect(
        container.querySelector('[data-testid="hitl-answer-stored"]'),
      ).not.toBeNull();

      act(() => root.unmount());
      root = createRoot(container);
      render("en", {
        answerState: "answer_stored",
        storedResponse: { optionId: "allow" },
      });

      expect(container.textContent).toContain(en.run.answerSaved);
      expect(container.textContent).toContain("Allow");
      expect(container.textContent).not.toContain("Deny");
    },
  );

  it("treats resume-queued as a delivered plan-review answer awaiting refresh", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ ok: true, state: "resume-queued" }), {
            status: 202,
          }),
      ),
    );
    render("en");
    await click("Allow");

    expect(
      container.querySelector('[data-testid="hitl-answer-recorded"]'),
    ).not.toBeNull();
    expect(container.textContent).toContain(en.run.answerRecorded);
    expect(container.textContent).not.toContain(en.run.retryDelivery);
    expect(container.textContent).not.toContain(en.run.answerSaved);
  });

  it("uses the authoritative answer after a losing-tab mismatch", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              code: "CONFLICT",
              details: { reason: "option_mismatch" },
            }),
            { status: 409 },
          ),
      ),
    );
    render("en");
    await click("Allow");
    render("en", {
      answerState: "answer_stored",
      storedResponse: { optionId: "deny" },
    });

    expect(container.textContent).toContain("Deny");
    expect(container.textContent).not.toContain("Allow");
  });

  it("keeps a specialized stored card noninteractive", () => {
    render("en", {
      kind: "infra_recovery",
      answerState: "answer_stored",
      storedResponse: null,
    });

    expect(container.textContent).toContain(en.run.answerSaved);
    const retryChoice = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === en.run.infraRecoveryRetry,
    );

    expect(retryChoice?.disabled).toBe(true);
  });

  it("lets a failed budget claim choose a different available recovery", async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );

    vi.stubGlobal("fetch", fetchMock);
    render("en", {
      kind: "budget_breach",
      schema: {
        kind: "budget_breach",
        scope: "run",
        meter: "tokens",
        current: 1200,
        limit: 1000,
      },
      answerState: "answer_stored",
      storedResponse: null,
      claimStage: "failed",
      availableOptions: [
        {
          optionId: "restart",
          label: "restart",
          helperText: "restart",
          destructive: false,
          dropAllowed: false,
          requiresBranchName: false,
          modes: [],
        },
      ],
    });

    const restart = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === en.run.budgetRestart,
    );

    expect(restart?.disabled).toBe(false);
    await click(en.run.budgetRestart);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      optionId: "restart",
    });
  });

  it("does not retry an option missing from the current permission choices", () => {
    render("en", {
      answerState: "answer_stored",
      storedResponse: { optionId: "obsolete" },
    });

    expect(container.textContent).toContain(en.run.savedInvalidOption);
    expect(container.textContent).not.toContain(en.run.retryDelivery);
  });

  it("shows a prompt-owner cause only as a code detail", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              code: "CONFLICT",
              details: {
                reason: "prompt_owner_invariant",
                causeCode: "owner_shape",
              },
            }),
            { status: 409 },
          ),
      ),
    );
    render("en");
    await click("Allow");

    expect(container.querySelector("code")?.textContent).toBe("owner_shape");
    expect(container.textContent).toContain(
      en.run.errorReasons.prompt_owner_invariant,
    );
  });

  it("does not claim a stored answer when the browser cannot confirm delivery", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("network down");
      }),
    );
    render("en");
    await click("Allow");

    expect(container.textContent).toContain(en.run.deliveryUnconfirmed);
    expect(container.textContent).toContain("Deny");
    expect(container.textContent).not.toContain(en.run.answerSaved);
  });

  it("emits the terminal reason before refresh removes the card", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              code: "HITL_TIMEOUT",
              details: { reason: "agent_session_ended" },
            }),
            { status: 410 },
          ),
      ),
    );
    render("en");
    await click("Allow");

    expect(feedbackError).toHaveBeenCalledWith({
      message: en.run.errorReasons.agent_session_ended,
      mutationId: expect.stringMatching(/^hitl-terminal:run-1:hitl-1:1$/),
    });
    act(() => root.unmount());
    root = createRoot(container);
    expect(feedbackError).toHaveBeenCalledTimes(1);
  });

  it("ignores an old request's late acknowledgement after the card identity changes", async () => {
    let settle: ((response: Response) => void) | null = null;

    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            settle = resolve;
          }),
      ),
    );
    render("en");
    await act(async () => {
      const allow = [...container.querySelectorAll("button")].find(
        (button) => button.textContent === "Allow",
      );

      allow?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    render("en", { hitlRequestId: "hitl-2" });
    await act(async () => {
      settle?.(
        new Response(
          JSON.stringify({ ok: true, state: "resume-in-progress" }),
          { status: 202 },
        ),
      );
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Deny");
    expect(container.textContent).not.toContain(en.run.answerSaved);
  });
});

const inboxItem: HitlItem = {
  hitlRequestId: "hitl-1",
  runId: "run-1",
  runKind: "flow",
  kind: "permission",
  answerState: "open",
  storedResponse: null,
  assignmentId: null,
  assignmentStatus: null,
  assignmentActionKind: null,
  assignmentRoleRefs: [],
  assignmentStaleEvidenceSummary: null,
  assigneeLabel: null,
  assigneeUserId: null,
  agent: "claude",
  branch: "main",
  flowRef: "flow",
  stage: { label: "Review", type: "human" },
  taskRef: "T-1",
  taskTitle: "Test",
  prompt: "Allow?",
  options: [
    { optionId: "allow", label: "Allow" },
    { optionId: "deny", label: "Deny" },
  ],
  time: "1m",
  createdAt: "2026-09-23T00:00:00.000Z",
  schema: null,
  criticality: "low",
};

function renderInbox(item: HitlItem, expanded: boolean): void {
  act(() =>
    root.render(
      createElement(
        TestIntlProvider,
        { locale: "en", messages: en },
        createElement(HitlPanel, {
          item,
          expanded,
          canAct: true,
          currentUserId: "operator",
        }),
      ),
    ),
  );
}

describe("inbox card response mounts", () => {
  it("uses scratch recovery copy for an inbox scratch permission 410", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              code: "HITL_TIMEOUT",
              details: { reason: "agent_session_ended" },
            }),
            { status: 410 },
          ),
      ),
    );
    renderInbox({ ...inboxItem, runKind: "scratch" }, false);
    await click("Allow");

    expect(container.textContent).toContain(
      en.run.errorReasons.agent_session_ended_scratch,
    );
    expect(container.textContent).not.toContain(
      en.run.errorReasons.agent_session_ended,
    );
  });

  it("locks the inbox choice immediately after a retryable 503", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              code: "EXECUTOR_UNAVAILABLE",
              details: { reason: "delivery_unavailable" },
            }),
            { status: 503 },
          ),
      ),
    );
    renderInbox(inboxItem, false);
    await click("Allow");

    expect(
      container.querySelector('[data-testid="hitl-answer-stored"]'),
    ).not.toBeNull();
    expect(container.textContent).toContain(en.run.retryDelivery);
    expect(container.textContent).not.toContain("Deny");
  });

  it("keeps the collapsed permission card read-only through onRespond refresh", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.endsWith("/respond")
          ? new Response(
              JSON.stringify({ ok: true, state: "resume-in-progress" }),
              { status: 202 },
            )
          : new Response(JSON.stringify({}), { status: 200 }),
      ),
    );
    renderInbox(inboxItem, false);
    await click("Allow");
    renderInbox(inboxItem, false);

    expect(router.refresh).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain(en.run.answerSaved);
    expect(container.textContent).not.toContain("Deny");
  });

  it("keeps the expanded form response read-only through its callback refresh", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.endsWith("/respond")
          ? new Response(
              JSON.stringify({ ok: true, state: "delivery-in-progress" }),
              { status: 202 },
            )
          : new Response(
              JSON.stringify({
                gates: [],
                diff: null,
                budgetProgress: null,
                claimStage: null,
                availableOptions: null,
              }),
              { status: 200 },
            ),
      ),
    );
    const item: HitlItem = {
      ...inboxItem,
      kind: "form",
      schema: { fields: [] },
    };

    renderInbox(item, true);
    await act(async () => {});
    await click(en.run.submit);
    renderInbox(item, true);

    expect(router.refresh).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain(en.run.answerSaved);
    expect(container.textContent).not.toContain(en.run.submit);
  });

  it("renders an authoritative stored non-permission card before expansion", () => {
    renderInbox(
      {
        ...inboxItem,
        kind: "form",
        answerState: "answer_stored",
        storedResponse: { response: { approved: true } },
      },
      false,
    );

    expect(container.textContent).toContain(en.run.answerSaved);
    expect(container.textContent).not.toContain(en.inbox.respond);
  });

  it("keeps failed budget recovery in the expanded inbox controls", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              gates: [],
              diff: null,
              budgetProgress: null,
              claimStage: null,
              availableOptions: null,
            }),
            { status: 200 },
          ),
      ),
    );
    renderInbox(
      {
        ...inboxItem,
        kind: "budget_breach",
        answerState: "answer_stored",
        claimStage: "failed",
        schema: {
          kind: "budget_breach",
          scope: "run",
          meter: "tokens",
          current: 1200,
          limit: 1000,
        },
        availableOptions: [
          {
            optionId: "restart",
            label: "restart",
            helperText: "restart",
            destructive: false,
            dropAllowed: false,
            requiresBranchName: false,
            modes: [],
          },
        ],
      },
      true,
    );
    await act(async () => {});

    const restart = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === en.run.budgetRestart,
    );

    expect(restart?.disabled).toBe(false);
    expect(
      container.querySelectorAll('[data-testid="budget-breach-card"]'),
    ).toHaveLength(1);
    expect(container.textContent).not.toContain(en.run.answerSaved);
  });
});
