// @vitest-environment jsdom

import type { WorkbenchLifecycleActionId } from "@/lib/workbench-lifecycle/policy";

import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
  useTranslations:
    (namespace: string) =>
    (key: string, values?: Record<string, unknown>): string =>
      values
        ? `${namespace}.${key} ${JSON.stringify(values)}`
        : `${namespace}.${key}`,
}));

const refreshMock = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: refreshMock }),
}));

import { WorkbenchLifecycleActions } from "@/components/workbench/lifecycle-actions";

type Rendered = {
  container: HTMLDivElement;
  root: Root;
};
type FetchLike = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) => Promise<Response>;

const roots: Root[] = [];

function setupActEnvironment(): void {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
}

function renderActions(actions: WorkbenchLifecycleActionId[]): Rendered {
  const container = document.createElement("div");
  const root = createRoot(container);

  document.body.appendChild(container);
  roots.push(root);

  act(() => {
    root.render(
      createElement(WorkbenchLifecycleActions, {
        runId: "run-1",
        runKind: "flow",
        actions,
      }),
    );
  });

  return { container, root };
}

function textOf(element: Element): string {
  return element.textContent ?? "";
}

function findButton(container: ParentNode, label: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll("button")).find((item) =>
    textOf(item).includes(label),
  );

  if (!button) throw new Error(`button not found: ${label}`);

  return button;
}

function findTextarea(container: ParentNode): HTMLTextAreaElement {
  const textarea = container.querySelector("textarea");

  if (!textarea) throw new Error("textarea not found");

  return textarea;
}

function findInput(container: ParentNode): HTMLInputElement {
  const input = container.querySelector("input");

  if (!input) throw new Error("input not found");

  return input;
}

function findSelect(container: ParentNode): HTMLSelectElement {
  const select = container.querySelector("select");

  if (!select) throw new Error("select not found");

  return select;
}

async function click(element: Element): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

async function changeInput(
  element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  value: string,
): Promise<void> {
  await act(async () => {
    const prototype =
      element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : element instanceof HTMLSelectElement
          ? HTMLSelectElement.prototype
          : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;

    if (!setter) throw new Error("value setter not found");

    setter.call(element, value);
    element.dispatchEvent(
      new Event(element instanceof HTMLSelectElement ? "change" : "input", {
        bubbles: true,
      }),
    );
  });
}

async function flushPromises(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function metadataResponse(dirty = false): Response {
  return jsonResponse({
    ok: true,
    runId: "run-1",
    branch: "maister/run-1",
    dirty,
    remotes: ["origin", "backup"],
    defaultRemote: "origin",
    suggestedHandoffBranch: "maister/handoff/run-1",
    checkoutCommands: [
      "git -C /repo fetch origin maister/handoff/run-1",
      "git -C /repo switch --track origin/maister/handoff/run-1",
    ],
  });
}

beforeEach(() => {
  setupActEnvironment();
  refreshMock.mockReset();
  vi.restoreAllMocks();
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn() },
  });
});

afterEach(() => {
  for (const root of roots) {
    act(() => root.unmount());
  }
  roots.length = 0;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe("WorkbenchLifecycleActions dialogs", () => {
  it("opens and closes an in-app confirmation dialog with focus restored", async () => {
    const { container } = renderActions(["archive"]);
    const archiveButton = findButton(
      container,
      "workbenchLifecycle.action.archive",
    );

    archiveButton.focus();
    await click(archiveButton);

    expect(container.querySelector('[role="dialog"]')).not.toBeNull();

    await click(findButton(container, "workbenchLifecycle.dialog.cancel"));

    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(archiveButton);
  });

  it("requires a commit message before calling snapshot-commit", async () => {
    const fetchMock = vi.fn<FetchLike>(async () => metadataResponse(true));

    vi.stubGlobal("fetch", fetchMock);

    const { container } = renderActions(["exportBranch"]);

    await click(
      findButton(container, "workbenchLifecycle.action.snapshotCommit"),
    );
    await flushPromises();
    await changeInput(findTextarea(container), "");

    const commitButton = findButton(
      container,
      "workbenchLifecycle.dialog.commit",
    );

    expect(commitButton.disabled).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("disables snapshot commit when the worktree is already clean", async () => {
    const fetchMock = vi.fn<FetchLike>(async () => metadataResponse(false));

    vi.stubGlobal("fetch", fetchMock);

    const { container } = renderActions(["exportBranch"]);

    await click(
      findButton(container, "workbenchLifecycle.action.snapshotCommit"),
    );
    await flushPromises();

    expect(
      findButton(container, "workbenchLifecycle.dialog.commit").disabled,
    ).toBe(true);
  });

  it("pushes the run branch and exposes force-with-lease after a conflict", async () => {
    const exportBodies: Record<string, unknown>[] = [];
    const fetchMock = vi.fn<FetchLike>(async (input, init) => {
      const url = String(input);

      if (url.endsWith("/handoff-metadata")) {
        return metadataResponse(false);
      }

      if (url.endsWith("/export-branch")) {
        exportBodies.push(
          JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
        );

        if (exportBodies.length === 1) {
          return jsonResponse(
            {
              code: "CONFLICT",
              message: "remote branch has newer commits",
              pushRejected: "non_fast_forward",
              canForce: true,
              retryHint: "Review the remote branch or force push.",
            },
            { status: 409 },
          );
        }

        return jsonResponse({
          ok: true,
          runId: "run-1",
          branch: "maister/run-1",
          remote: "origin",
          pushedRef: "origin/maister/run-1",
          snapshotCreated: false,
          checkoutCommands: [
            "git -C /repo fetch origin maister/run-1",
            "git -C /repo switch maister/run-1",
          ],
        });
      }

      throw new Error(`unexpected fetch: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    const { container } = renderActions(["exportBranch"]);

    await click(
      findButton(container, "workbenchLifecycle.action.exportBranch"),
    );
    await flushPromises();
    await click(findButton(container, "workbenchLifecycle.dialog.push"));
    await flushPromises();

    expect(textOf(container)).toContain("remote branch has newer commits");
    expect(textOf(container)).toContain("Review the remote branch");

    await click(findButton(container, "workbenchLifecycle.dialog.forcePush"));
    await flushPromises();

    expect(exportBodies).toEqual([
      {
        remote: "origin",
        snapshotDirty: false,
        commitMessage: null,
        force: false,
      },
      {
        remote: "origin",
        snapshotDirty: false,
        commitMessage: null,
        force: true,
      },
    ]);
    expect(textOf(container)).toContain("origin/maister/run-1");
    expect(refreshMock).toHaveBeenCalled();
  });

  it("validates handoff fields, renders backend errors, and copies checkout commands", async () => {
    let handoffCalls = 0;
    let lastHandoffBody: Record<string, unknown> | null = null;
    const fetchMock = vi.fn<FetchLike>(async (input, init) => {
      const url = String(input);

      if (url.endsWith("/handoff-metadata")) {
        return metadataResponse(false);
      }

      if (url.endsWith("/handoff-branch")) {
        handoffCalls += 1;
        lastHandoffBody = JSON.parse(String(init?.body ?? "{}")) as Record<
          string,
          unknown
        >;

        if (handoffCalls === 1) {
          return jsonResponse({ code: "CONFLICT" }, { status: 409 });
        }

        return jsonResponse({
          ok: true,
          runId: "run-1",
          branch: "maister/run-1",
          handoffBranch: "maister/handoff/run-1",
          remote: "backup",
          pushedRef: "backup/maister/handoff/run-1",
          headCommit: "abc1234",
          checkoutCommands: [
            "git -C /repo fetch backup maister/handoff/run-1",
            "git -C /repo switch --track backup/maister/handoff/run-1",
          ],
        });
      }

      throw new Error(`unexpected fetch: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    const { container } = renderActions(["exportBranch"]);

    await click(
      findButton(container, "workbenchLifecycle.action.exportBranch"),
    );
    await flushPromises();
    await changeInput(findSelect(container), "backup");
    await changeInput(findInput(container), "bad..branch");

    expect(
      findButton(container, "workbenchLifecycle.dialog.handoff").disabled,
    ).toBe(true);
    expect(textOf(container)).toContain(
      "workbenchLifecycle.dialog.invalidBranch",
    );

    await changeInput(findInput(container), "maister/handoff/run-1");
    await click(findButton(container, "workbenchLifecycle.dialog.handoff"));
    await flushPromises();

    expect(textOf(container)).toContain("workbenchLifecycle.errorWithCode");
    expect(textOf(container)).toContain("CONFLICT");

    await click(findButton(container, "workbenchLifecycle.dialog.handoff"));
    await flushPromises();

    expect(lastHandoffBody).toMatchObject({
      remote: "backup",
      handoffBranch: "maister/handoff/run-1",
    });
    expect(textOf(container)).toContain(
      "git -C /repo switch --track backup/maister/handoff/run-1",
    );

    await click(findButton(container, "workbenchLifecycle.dialog.copy"));

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      "git -C /repo fetch backup maister/handoff/run-1",
    );
  });
});
