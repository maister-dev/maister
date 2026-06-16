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

vi.mock("next/link", () => ({
  default: (props: Record<string, unknown>) =>
    createElement("a", props as never),
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

type MenuProps = Parameters<typeof WorkbenchLifecycleActions>[0];

function renderMenu(over: Partial<MenuProps> = {}): Rendered {
  const container = document.createElement("div");
  const root = createRoot(container);

  document.body.appendChild(container);
  roots.push(root);

  act(() => {
    root.render(
      createElement(WorkbenchLifecycleActions, {
        runId: "run-1",
        runKind: "scratch",
        actions: ["stop"],
        variant: "menu",
        runHref: "/scratch-runs/run-1",
        taskKey: "KEY",
        taskNumber: 7,
        runLabel: "old name",
        ...over,
      }),
    );
  });

  return { container, root };
}

function byTestId(container: ParentNode, id: string): HTMLElement {
  const el = container.querySelector<HTMLElement>(`[data-testid="${id}"]`);

  if (!el) throw new Error(`testid not found: ${id}`);

  return el;
}

describe("WorkbenchLifecycleActions rail menu", () => {
  it("shows inline Stop and a live action-sheet (open, rename, stop & archive, stop & drop)", async () => {
    const { container } = renderMenu({ runKind: "scratch", actions: ["stop"] });

    expect(container.querySelector('[data-testid="rail-stop"]')).not.toBeNull();

    await click(byTestId(container, "rail-menu-trigger"));

    const sheet = byTestId(container, "rail-action-sheet");

    expect(sheet.querySelector('[data-testid="menu-open"]')).not.toBeNull();
    expect(sheet.querySelector('[data-testid="menu-rename"]')).not.toBeNull();
    expect(
      sheet.querySelector('[data-testid="menu-stopArchive"]'),
    ).not.toBeNull();
    expect(sheet.querySelector('[data-testid="menu-stopDrop"]')).not.toBeNull();
    // Plain Stop is the inline primary, never duplicated in the sheet.
    expect(sheet.querySelector('[data-testid="menu-stop"]')).toBeNull();
  });

  it("shows a terminal action-sheet (open, archive, drop) with no inline Stop", async () => {
    const { container } = renderMenu({
      runKind: "flow",
      actions: ["archive", "drop", "exportBranch"],
    });

    expect(container.querySelector('[data-testid="rail-stop"]')).toBeNull();

    await click(byTestId(container, "rail-menu-trigger"));

    const sheet = byTestId(container, "rail-action-sheet");

    expect(sheet.querySelector('[data-testid="menu-open"]')).not.toBeNull();
    expect(sheet.querySelector('[data-testid="menu-archive"]')).not.toBeNull();
    expect(sheet.querySelector('[data-testid="menu-drop"]')).not.toBeNull();
    // flow runs are not renamed here; snapshot/push stay in the run card.
    expect(sheet.querySelector('[data-testid="menu-rename"]')).toBeNull();
    expect(sheet.querySelector('[data-testid="menu-exportBranch"]')).toBeNull();
  });

  it("stop & archive posts to the combined flow endpoint", async () => {
    const fetchMock = vi.fn<FetchLike>(async () =>
      jsonResponse({
        ok: true,
        runId: "run-1",
        archived: true,
        archivedBranch: null,
        snapshotted: false,
        supervisorStopped: true,
      }),
    );

    vi.stubGlobal("fetch", fetchMock);

    const { container } = renderMenu({ runKind: "flow", actions: ["stop"] });

    await click(byTestId(container, "rail-menu-trigger"));
    await click(byTestId(container, "menu-stopArchive"));
    await click(findButton(container, "workbenchLifecycle.dialog.confirm"));
    await flushPromises();

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/runs/run-1/stop-archive",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("scratch stop & drop reuses the discard endpoint", async () => {
    const fetchMock = vi.fn<FetchLike>(async () => jsonResponse({ ok: true }));

    vi.stubGlobal("fetch", fetchMock);

    const { container } = renderMenu({ runKind: "scratch", actions: ["stop"] });

    await click(byTestId(container, "rail-menu-trigger"));
    await click(byTestId(container, "menu-stopDrop"));
    await click(findButton(container, "workbenchLifecycle.dialog.confirm"));
    await flushPromises();

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/scratch-runs/run-1/discard",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("rename posts the new name to the scratch rename endpoint", async () => {
    const fetchMock = vi.fn<FetchLike>(async () => jsonResponse({ ok: true }));

    vi.stubGlobal("fetch", fetchMock);

    const { container } = renderMenu({ runKind: "scratch", actions: ["stop"] });

    await click(byTestId(container, "rail-menu-trigger"));
    await click(byTestId(container, "menu-rename"));
    await changeInput(
      byTestId(container, "rename-input") as HTMLInputElement,
      "new name",
    );
    await click(byTestId(container, "rename-save"));
    await flushPromises();

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/scratch-runs/run-1",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ name: "new name" }),
      }),
    );
  });
});
