// @vitest-environment jsdom

import type { Root } from "react-dom/client";

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  COMMENT_SUBMIT_TIMEOUT_MS,
  CommentComposer,
} from "@/components/social/comment-composer";

const { router } = vi.hoisted(() => ({
  router: { refresh: vi.fn() },
}));

vi.mock("next/navigation", () => ({ useRouter: () => router }));

const labels = {
  placeholder: "Write a comment",
  submit: "Comment",
  submitting: "Posting…",
  hint: "Markdown supported",
  errorConfig: "Invalid comment",
  errorForbidden: "Forbidden",
  errorTimeout: "Timed out; refresh before retrying",
  errorGeneric: "Could not post",
  mentionListLabel: "Agents",
  mentionMatchCount: "$count agents",
};

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() =>
    root.render(
      createElement(CommentComposer, {
        slug: "demo",
        taskNumber: 7,
        labels,
      }),
    ),
  );
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function enterComment(value: string): void {
  const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
  const valueSetter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value",
  )?.set;

  valueSetter?.call(textarea, value);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("CommentComposer", () => {
  it("clears the draft and refreshes after a successful post", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ comment: { id: "comment-1" } }, { status: 201 }),
    );

    vi.stubGlobal("fetch", fetchMock);
    act(() => enterComment("hello"));
    await act(async () => container.querySelector("button")?.click());

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/projects/demo/tasks/7/comments",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ body: "hello" }),
        signal: expect.any(AbortSignal),
      }),
    );
    expect(
      (container.querySelector("textarea") as HTMLTextAreaElement).value,
    ).toBe("");
    expect(router.refresh).toHaveBeenCalledOnce();
  });

  it("restores the form and shows an API error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ code: "CRASH" }, { status: 500 })),
    );
    act(() => enterComment("keep this draft"));
    await act(async () => container.querySelector("button")?.click());

    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      labels.errorGeneric,
    );
    expect(
      (container.querySelector("textarea") as HTMLTextAreaElement).value,
    ).toBe("keep this draft");
    expect(container.querySelector("button")?.hasAttribute("disabled")).toBe(
      false,
    );
  });

  it("aborts a hung request and warns about an unknown outcome", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(new DOMException("Aborted", "AbortError")),
            );
          }),
      ),
    );
    act(() => enterComment("do not lose this"));
    act(() => container.querySelector("button")?.click());

    expect(container.querySelector("button")?.textContent).toContain(
      labels.submitting,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(COMMENT_SUBMIT_TIMEOUT_MS);
    });

    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      labels.errorTimeout,
    );
    expect(
      (container.querySelector("textarea") as HTMLTextAreaElement).value,
    ).toBe("do not lose this");
    expect(container.querySelector("button")?.hasAttribute("disabled")).toBe(
      false,
    );
  });
});
