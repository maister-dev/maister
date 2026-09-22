// @vitest-environment jsdom

import type { Root } from "react-dom/client";
import type { ScratchDetail } from "@/lib/scratch-runs/dialog";
import type { ComponentType, ReactNode } from "react";

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ScratchConversation } from "@/components/scratch/scratch-conversation";
import en from "@/messages/en.json";
import ru from "@/messages/ru.json";

const TestIntlProvider = NextIntlClientProvider as ComponentType<{
  locale: string;
  messages: typeof en;
  children?: ReactNode;
}>;

vi.mock("@/lib/use-run-stream", () => ({
  useRunStream: () => ({ eventCount: 0 }),
}));
vi.mock("@/components/scratch/scratch-composer", () => ({
  ScratchComposer: () => null,
}));

const openDetail = {
  run: {
    id: "run-1",
    projectSlug: null,
    capabilityAgent: "claude",
    runnerSnapshot: null,
    createdByDisplayName: "Operator",
  },
  scratch: { dialogStatus: "NeedsInput" },
  messages: [],
  attachments: [],
  workspace: null,
  capabilityProfile: null,
  pendingHitl: {
    hitlRequestId: "hitl-1",
    kind: "permission",
    prompt: "Allow file write?",
    schema: null,
    options: [
      { optionId: "allow", label: "Allow" },
      { optionId: "deny", label: "Deny" },
    ],
    answerState: "open",
    storedResponse: null,
  },
} as unknown as ScratchDetail;

let root: Root;
let container: HTMLDivElement;

function mount(runId = "run-1", locale: "en" | "ru" = "en"): void {
  act(() => {
    root.render(
      createElement(
        TestIntlProvider,
        {
          locale,
          messages: locale === "en" ? en : ru,
        },
        createElement(ScratchConversation, { runId }),
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
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("scratch HITL operator feedback", () => {
  it.each([
    [409, "CONFLICT", "permission_resume_in_flight"],
    [410, "HITL_TIMEOUT", "agent_session_ended"],
    [503, "EXECUTOR_UNAVAILABLE", "delivery_unavailable"],
  ] as const)(
    "renders the %i/%s reason after POST",
    async (status, code, reason) => {
      let postSeen = false;

      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => {
          if (url.endsWith("/respond")) {
            postSeen = true;

            return new Response(
              JSON.stringify({
                code,
                message: "opaque server text",
                details: { reason },
              }),
              { status },
            );
          }

          return new Response(
            JSON.stringify(
              status === 410 && postSeen
                ? {
                    ...openDetail,
                    pendingHitl: null,
                    scratch: { dialogStatus: "Crashed" },
                  }
                : openDetail,
            ),
            { status: 200 },
          );
        }),
      );
      mount();
      await act(async () => {});
      await click("Allow");

      const key =
        reason === "agent_session_ended"
          ? "agent_session_ended_scratch"
          : reason;

      expect(container.textContent).toContain(en.run.errorReasons[key]);
      expect(container.textContent).not.toContain(reason);
      expect(container.textContent).not.toContain("opaque server text");
      if (status === 503) {
        expect(container.textContent).toContain(en.run.answerSaved);
        expect(container.textContent).not.toContain("Deny");
      }
    },
  );

  it("keeps a 202 answer read-only through a stale detail refresh and retries it", async () => {
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) =>
      url.endsWith("/respond")
        ? new Response(
            JSON.stringify({ ok: true, state: "resume-in-progress" }),
            { status: 202 },
          )
        : new Response(JSON.stringify(openDetail), { status: 200 }),
    );

    vi.stubGlobal("fetch", fetchMock);
    mount();
    await act(async () => {});
    await click("Allow");

    expect(container.textContent).toContain(en.run.answerSaved);
    expect(container.textContent).not.toContain("Deny");
    expect(document.activeElement?.textContent).toBe(en.run.retryDelivery);
    await click(en.run.retryDelivery);
    const posts = fetchMock.mock.calls.filter(([url]) =>
      url.endsWith("/respond"),
    );

    expect(posts).toHaveLength(2);
    expect(JSON.parse(String(posts[1]?.[1]?.body))).toEqual({
      optionId: "allow",
    });
  });

  it("retranslates a refusal after the scratch locale changes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.endsWith("/respond")
          ? new Response(
              JSON.stringify({
                code: "CONFLICT",
                details: { reason: "assignment_fenced" },
              }),
              { status: 409 },
            )
          : new Response(JSON.stringify(openDetail), { status: 200 }),
      ),
    );
    mount();
    await act(async () => {});
    await click("Allow");
    expect(container.textContent).toContain(
      en.run.errorReasons.assignment_fenced,
    );

    mount("run-1", "ru");
    expect(container.textContent).toContain(
      ru.run.errorReasons.assignment_fenced,
    );
    expect(container.textContent).not.toContain(
      en.run.errorReasons.assignment_fenced,
    );
  });

  it("ignores a stale detail GET when the conversation switches runs", async () => {
    let settleOld: ((response: Response) => void) | null = null;

    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) =>
        url.endsWith("/run-1")
          ? new Promise<Response>((resolve) => {
              settleOld = resolve;
            })
          : Promise.resolve(
              new Response(
                JSON.stringify({
                  ...openDetail,
                  run: { ...openDetail.run, id: "run-2" },
                  pendingHitl: {
                    ...openDetail.pendingHitl,
                    prompt: "New run prompt",
                  },
                }),
                { status: 200 },
              ),
            ),
      ),
    );
    mount("run-1");
    await act(async () => {});
    mount("run-2");
    await act(async () => {});
    await act(async () => {
      settleOld?.(new Response(JSON.stringify(openDetail), { status: 200 }));
      await Promise.resolve();
    });

    expect(container.textContent).toContain("New run prompt");
    expect(container.textContent).not.toContain("Allow file write?");
  });
});
