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

const { stream } = vi.hoisted(() => ({ stream: { eventCount: 0 } }));

vi.mock("@/lib/use-run-stream", () => ({
  useRunStream: () => ({ eventCount: stream.eventCount }),
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
  stream.eventCount = 0;
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

  it("does not retry a saved permission option that no longer exists", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              ...openDetail,
              pendingHitl: {
                ...openDetail.pendingHitl,
                answerState: "answer_stored",
                storedResponse: { optionId: "obsolete" },
              },
            }),
            { status: 200 },
          ),
      ),
    );
    mount();
    await act(async () => {});

    expect(container.textContent).toContain(en.run.savedInvalidOption);
    expect(container.textContent).not.toContain(en.run.retryDelivery);
  });

  it.each(["en", "ru"] as const)(
    "shows the %s prompt-owner diagnostic as a code detail",
    async (locale) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) =>
          url.endsWith("/respond")
            ? new Response(
                JSON.stringify({
                  code: "CONFLICT",
                  message: "opaque server text",
                  details: {
                    reason: "prompt_owner_invariant",
                    causeCode: "owner_shape",
                  },
                }),
                { status: 409 },
              )
            : new Response(JSON.stringify(openDetail), { status: 200 }),
        ),
      );
      mount("run-1", locale);
      await act(async () => {});
      await click("Allow");

      const messages = locale === "en" ? en : ru;

      expect(container.textContent).toContain(
        messages.run.errorReasons.prompt_owner_invariant,
      );
      expect(container.textContent).toContain(messages.run.errorDiagnostic);
      expect(container.querySelector("code")?.textContent).toBe("owner_shape");
      expect(container.textContent).not.toContain("opaque server text");
    },
  );

  it("does not show an old refusal beside the next request on the same run", async () => {
    let postSeen = false;
    const nextDetail = {
      ...openDetail,
      pendingHitl: {
        ...openDetail.pendingHitl!,
        hitlRequestId: "hitl-2",
        prompt: "Second permission prompt",
      },
    };

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/respond")) {
          postSeen = true;

          return new Response(
            JSON.stringify({
              code: "CONFLICT",
              details: { reason: "option_mismatch" },
            }),
            { status: 409 },
          );
        }

        return new Response(
          JSON.stringify(postSeen ? nextDetail : openDetail),
          {
            status: 200,
          },
        );
      }),
    );
    mount();
    await act(async () => {});
    await click("Allow");

    expect(container.textContent).toContain("Second permission prompt");
    expect(container.textContent).not.toContain(
      en.run.errorReasons.option_mismatch,
    );
  });

  it.each([
    [409, "CONFLICT", "option_mismatch"],
    [410, "HITL_TIMEOUT", "agent_session_ended"],
  ] as const)(
    "ignores a late %i refusal after a newer request",
    async (status, code, reason) => {
      let settleOld: ((response: Response) => void) | null = null;
      let currentDetail = openDetail;
      const postUrls: string[] = [];

      vi.stubGlobal(
        "fetch",
        vi.fn((url: string) => {
          if (url.endsWith("/respond")) {
            postUrls.push(url);

            return url.includes("hitl-1")
              ? new Promise<Response>((resolve) => {
                  settleOld = resolve;
                })
              : Promise.resolve(
                  new Response(
                    JSON.stringify({ ok: true, state: "resume-in-progress" }),
                    { status: 202 },
                  ),
                );
          }

          return Promise.resolve(
            new Response(JSON.stringify(currentDetail), { status: 200 }),
          );
        }),
      );
      mount();
      await act(async () => {});
      await click("Allow");

      currentDetail = {
        ...openDetail,
        pendingHitl: {
          ...openDetail.pendingHitl!,
          hitlRequestId: "hitl-2",
          prompt: "Second permission prompt",
        },
      };
      stream.eventCount = 1;
      mount();
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 275));
      });
      expect(container.textContent).toContain("Second permission prompt");
      await click("Allow");
      expect(postUrls).toHaveLength(2);

      if (status === 410) {
        currentDetail = { ...currentDetail, pendingHitl: null };
        stream.eventCount = 2;
        mount();
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 275));
        });
      }

      await act(async () => {
        settleOld?.(
          new Response(
            JSON.stringify({
              code,
              details: { reason },
            }),
            { status },
          ),
        );
        await Promise.resolve();
      });

      if (status === 409) {
        expect(container.textContent).toContain(en.run.answerSaved);
      }
      expect(container.textContent).not.toContain(en.run.errorReasons[reason]);
    },
  );

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
