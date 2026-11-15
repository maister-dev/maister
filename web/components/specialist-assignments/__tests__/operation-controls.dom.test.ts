// @vitest-environment jsdom

import type { Root } from "react-dom/client";
import type { StandOperation } from "@/lib/stand-operations/operation-types";

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const router = vi.hoisted(() => ({ refresh: vi.fn() }));
const feedback = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));

vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));
vi.mock("@/components/feedback/feedback-provider", () => ({
  useFeedback: () => feedback,
}));

import { StandOperationControls } from "@/components/specialist-assignments/operation-controls";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];
const operation: StandOperation = {
  id: "operation-1",
  assignmentId: "assignment-1",
  componentId: "api",
  targetIncarnation: "incarnation-1",
  requestDigest: "a".repeat(64),
  effectState: "not_dispatched",
  verificationState: "not_checked",
  disposition: "pending",
  receiptIds: [],
  verificationIds: [],
  predecessorId: null,
  successorId: null,
  revision: 3,
};

function mount(
  props: Partial<Parameters<typeof StandOperationControls>[0]>,
): HTMLDivElement {
  const container = document.createElement("div");
  const root = createRoot(container);

  document.body.appendChild(container);
  roots.push(root);
  act(() => {
    root.render(
      createElement(StandOperationControls, {
        operation,
        needsApproval: true,
        canRestart: true,
        canRecover: false,
        canVerify: false,
        successorChoices: [],
        ...props,
      }),
    );
  });

  return container;
}

function button(name: string): HTMLButtonElement {
  const found = [...document.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === name,
  );

  if (!found) throw new Error(`No button named ${name}`);

  return found;
}

async function click(target: HTMLElement): Promise<void> {
  await act(async () => {
    target.click();
  });
}

function type(field: HTMLTextAreaElement | HTMLSelectElement, value: string) {
  const prototype =
    field instanceof HTMLSelectElement
      ? window.HTMLSelectElement.prototype
      : window.HTMLTextAreaElement.prototype;

  act(() => {
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(
      field,
      value,
    );
    field.dispatchEvent(new Event("input", { bubbles: true }));
    field.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })),
  );
});

afterEach(async () => {
  vi.unstubAllGlobals();
  router.refresh.mockReset();
  feedback.success.mockReset();
  feedback.error.mockReset();
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.innerHTML = "";
});

describe("StandOperationControls", () => {
  it("approves a restart only after an explicit confirmation with a reason", async () => {
    mount({});
    await click(button("approveRestart"));
    const dialog = document.querySelector('[role="dialog"]');

    expect(dialog?.textContent).toContain(operation.requestDigest);
    expect(fetch).not.toHaveBeenCalled();
    expect(button("confirmAction.approval").disabled).toBe(true);
    type(
      dialog!.querySelector("textarea") as HTMLTextAreaElement,
      "Disposable stand restart.",
    );
    await click(button("confirmAction.approval"));

    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = vi.mocked(fetch).mock.calls[0]!;

    expect(url).toBe("/api/stand-operations/operation-1/approval");
    expect(JSON.parse(String(init?.body))).toMatchObject({
      expectedRevision: 3,
      requestDigest: operation.requestDigest,
      reason: "Disposable stand restart.",
      idempotencyKey: expect.any(String),
    });
    expect(feedback.success).toHaveBeenCalledOnce();
    expect(router.refresh).toHaveBeenCalledOnce();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("hides verification from a viewer without verify authority", () => {
    const view = mount({
      operation: { ...operation, effectState: "confirmed_applied" },
      needsApproval: false,
    });

    expect(view.textContent).toBe("");
    mount({
      operation: { ...operation, effectState: "confirmed_applied" },
      needsApproval: false,
      canVerify: true,
    });
    expect(button("verify")).toBeTruthy();
  });

  it("authorizes a successor picked from server choices with their exact revisions", async () => {
    vi.mocked(fetch).mockImplementationOnce(
      async () =>
        new Response(
          JSON.stringify({ id: "inspection-1", observedState: "active" }),
          { status: 201 },
        ),
    );
    mount({
      operation: { ...operation, effectState: "unknown" },
      needsApproval: false,
      canRecover: true,
      successorChoices: [
        {
          id: "assignment-2",
          objective: "Restart api again",
          revision: 4,
          inputRevision: 2,
        },
      ],
    });
    await click(button("inspect"));
    await click(button("authorizeSuccessor"));
    const dialog = document.querySelector('[role="dialog"]')!;

    type(dialog.querySelector("select") as HTMLSelectElement, "assignment-2");
    type(
      dialog.querySelector("textarea") as HTMLTextAreaElement,
      "Inspected active; authorize a fresh restart.",
    );
    await click(button("confirmAction.successor"));
    const [url, init] = vi.mocked(fetch).mock.calls[1]!;

    expect(url).toBe("/api/stand-operations/operation-1/recovery-decisions");
    expect(JSON.parse(String(init?.body))).toMatchObject({
      decision: "authorize_successor",
      inspectionIds: ["inspection-1"],
      successor: {
        assignmentId: "assignment-2",
        expectedRevision: 4,
        inputRevision: 2,
      },
    });
  });
});
