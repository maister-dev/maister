// @vitest-environment jsdom

import type { HumanAssessmentDraft } from "@/lib/tasks/human-assessment-schema";

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const translate = (key: string): string => key;

vi.mock("next-intl", () => ({ useTranslations: () => translate }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

import { HumanAssessmentForm } from "@/components/agents/human-assessment-form";
import { TaskQualificationControl } from "@/components/agents/task-qualification-control";

const endpoint = "/api/projects/example/tasks/task-1/human-assessment";
const draft: HumanAssessmentDraft = {
  contextToken: "a".repeat(64),
  expectedInputRevision: 1,
  expectedQualificationRevision: null,
  tasks: [{ id: "task-1", label: "MAI-27 · Reviewed request" }],
  runs: [{ id: "run-1", label: "Earlier investigation" }],
};
let root: Root;

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
}

async function click(text: string): Promise<void> {
  const button = [...document.querySelectorAll("button")].find(
    (item) => item.textContent === text,
  );

  if (!button) throw new Error(`Missing button ${text}`);
  await act(async () => button.click());
}

async function change(
  element: HTMLTextAreaElement | HTMLSelectElement,
  value: string,
): Promise<void> {
  const prototype =
    element instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : HTMLTextAreaElement.prototype;

  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(
      element,
      value,
    );
    element.dispatchEvent(
      new Event(element instanceof HTMLSelectElement ? "change" : "input", {
        bubbles: true,
      }),
    );
  });
}

function render(element: React.ReactNode): void {
  const container = document.createElement("div");

  document.body.append(container);
  root = createRoot(container);
  act(() => root.render(element));
}

function renderAuthoringControl(): void {
  render(
    createElement(TaskQualificationControl, {
      taskId: "task-1",
      slug: "example",
      canAct: true,
      summary: {
        required: true,
        mode: "required",
        inputRevision: 1,
        qualificationRevision: null,
        qualificationId: null,
        decision: null,
        publicationState: null,
        freshness: "unassessed",
        blockedReason: "qualification_required",
        nextActions: [],
        candidate: null,
      },
    }),
  );
}

async function closeWithEscape(): Promise<void> {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  });
  expect(document.querySelector('[role="dialog"]')).toBeNull();
}

beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => {
  if (root) act(() => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

it.each([false, null] as const)(
  "keeps the failed qualifier inspectable for a readonly task viewer without inventing model-start evidence (%s)",
  (modelStarted) => {
    render(
      createElement(TaskQualificationControl, {
        taskId: "task-1",
        slug: "example",
        canAct: false,
        summary: {
          required: true,
          mode: "required",
          inputRevision: 1,
          qualificationRevision: null,
          qualificationId: null,
          decision: null,
          publicationState: null,
          freshness: "unassessed",
          blockedReason: "qualification_required",
          nextActions: [],
          candidate: null,
          sourceFailure: {
            runId: "failed-qualifier",
            stage: modelStarted === false ? "baseline" : null,
            causeCode: modelStarted === false ? "ENOENT" : null,
            modelStarted,
          },
        },
      }),
    );

    expect(document.body.textContent).toContain("admission.triageFailed");
    expect(
      document.querySelector('a[href="/runs/failed-qualifier"]')?.textContent,
    ).toBe("admission.openFailure");
    expect(document.querySelector("button")).toBeNull();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    if (modelStarted === false)
      expect(document.body.textContent).toContain(
        "admission.beforeModelFailure",
      );
    else
      expect(document.body.textContent).not.toContain(
        "admission.beforeModelFailure",
      );
  },
);

it("keeps an unfinished assessment and selected evidence when closed and reopened", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => response(draft)),
  );
  renderAuthoringControl();
  await click("humanAssessment");
  const selects = document.querySelectorAll("select");

  await change(selects[0], "bug");
  await change(selects[2], "task-1");
  await click("authoring.addTask");
  await change(document.querySelector("textarea")!, "Unfinished analysis");
  await act(async () =>
    document.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click(),
  );
  await closeWithEscape();
  await click("humanAssessment");
  expect(document.querySelector("select")?.value).toBe("bug");
  expect(document.querySelector("textarea")?.value).toBe("Unfinished analysis");
  expect(
    document.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked,
  ).toBe(true);
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("LA11 opens optional authoring only on request and recovers the exact held submission after a lost response and reopening", async () => {
  const posts: string[] = [];

  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, options?: RequestInit) => {
      if (options?.method === "POST") {
        posts.push(String(options.body));
        if (posts.length === 1) throw new TypeError("Lost response");

        return response({ qualificationId: "saved" });
      }
      if (url.endsWith("/qualifications"))
        return response({ items: [], nextCursor: null, asOf: "now" });

      return response(draft);
    }),
  );
  renderAuthoringControl();

  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
  await click("humanAssessment");
  expect(
    document.querySelector('[role="dialog"]')?.getAttribute("aria-labelledby"),
  ).toBe("human-assessment-title");
  expect(document.body.textContent).toContain("authoring.optional");
  expect(document.body.textContent).not.toContain("reasonInput");
  expect(document.body.textContent).not.toContain("evidenceInput");
  [...document.querySelectorAll("button")]
    .find((button) => button.textContent === "save")!
    .focus();
  await click("save");
  expect(document.querySelector("textarea")?.getAttribute("aria-invalid")).toBe(
    "true",
  );
  expect(document.activeElement).toBe(document.querySelector("textarea"));
  expect(posts).toHaveLength(0);
  const selects = document.querySelectorAll("select");

  await change(selects[2], "task-1");
  await click("authoring.addTask");
  for (const checkbox of document.querySelectorAll<HTMLInputElement>(
    'input[type="checkbox"]',
  ))
    await act(async () => checkbox.click());
  const rationales = document.querySelectorAll("textarea");

  for (const rationale of [...rationales].slice(0, 7))
    await change(
      rationale,
      "Reviewed the request; an acceptance example is missing.",
    );
  await change(
    rationales[7],
    "Provide one concrete input and expected output.",
  );
  await click("save");

  expect(document.querySelector('[role="alert"]')?.textContent).toContain(
    "unknownWrite",
  );
  expect(posts).toHaveLength(1);
  await closeWithEscape();
  await click("humanAssessment");
  expect(document.querySelector('[role="alert"]')?.textContent).toContain(
    "unknownWrite",
  );
  await click("sameRequest");
  expect(posts).toHaveLength(2);
  expect(posts[1]).toBe(posts[0]);
  expect(JSON.parse(posts[0])).toMatchObject({
    evidence: [{ kind: "task", taskId: "task-1" }],
    decision: "needs_review",
    checks: Array.from({ length: 7 }, () =>
      expect.objectContaining({ evidenceIndexes: [0] }),
    ),
  });
  expect(posts[0]).not.toContain("evidenceIds");
  expect(posts[0]).not.toContain("reasonCodes");
});

it("LA11 explains missing repository relevance and browses tracked files with a server token", async () => {
  const saved = vi.fn();
  const calls: string[] = [];

  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, options?: RequestInit) => {
      calls.push(url);
      if (options?.method === "POST")
        return response({ qualificationId: "saved" });
      if (url.includes("repository=1"))
        return response({
          ...draft,
          repository: { token: "b".repeat(64), ref: "c".repeat(40) },
        });

      return response({
        path: "",
        entries: [{ name: "README.md", type: "file" }],
      });
    }),
  );
  render(
    createElement(HumanAssessmentForm, {
      endpoint,
      slug: "example",
      initialDraft: draft,
      onClose: vi.fn(),
      onSaved: saved,
    }),
  );
  await change(document.querySelectorAll("select")[1], "ready");
  const checkFields = [...document.querySelectorAll("fieldset")].filter(
    (item) => item.querySelector(":scope > legend"),
  );

  for (const [index, field] of checkFields.entries()) {
    await change(
      field.querySelector("select")!,
      index === 6 ? "not_applicable" : "pass",
    );
    await change(
      field.querySelector("textarea")!,
      "Reviewed the actual task and repository context.",
    );
  }
  await click("save");
  expect(document.querySelector('[role="alert"]')?.textContent).toContain(
    "authoring.validation.repository",
  );
  expect(saved).not.toHaveBeenCalled();
  await click("authoring.browseFiles");
  await click("+ README.md");
  const relevance = [...document.querySelectorAll("fieldset")].find(
    (item) =>
      item.querySelector(":scope > legend")?.textContent ===
      "dimension.relevance",
  );

  await act(async () =>
    relevance
      ?.querySelector<HTMLInputElement>('input[type="checkbox"]')
      ?.click(),
  );
  await click("save");
  expect(saved).toHaveBeenCalledOnce();
  expect(calls).toContain(
    `/api/projects/example/files?ref=${"c".repeat(40)}&path=`,
  );
});
