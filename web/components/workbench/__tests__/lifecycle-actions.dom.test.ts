// @vitest-environment jsdom

import type { WorkbenchLifecycleActionId } from "@/lib/workbench-lifecycle/policy";

import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next-intl", async () => {
  const { default: messages } = await import("@/messages/en.json");
  const errors: Record<string, string> = messages.workbenchLifecycle.errors;

  return {
    useTranslations: (namespace: string) =>
      Object.assign(
        (key: string, values?: Record<string, unknown>): string => {
          if (namespace === "workbenchLifecycle" && key.startsWith("errors."))
            return errors[key.slice(7)];

          return values
            ? `${namespace}.${key} ${JSON.stringify(values)}`
            : `${namespace}.${key}`;
        },
        {
          has: (key: string): boolean =>
            key.startsWith("errors.") && key.slice(7) in errors,
        },
      ),
  };
});

const refreshMock = vi.fn();

let searchParams = new URLSearchParams();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: refreshMock }),
  useSearchParams: () => searchParams,
}));

vi.mock("@/components/feedback/feedback-provider", () => ({
  useFeedback: () => ({ success: vi.fn(), error: vi.fn() }),
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
  searchParams = new URLSearchParams();
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
    renderActions(["archive"]);
    const archiveButton = findButton(
      document.body,
      "workbenchLifecycle.action.archive",
    );

    archiveButton.focus();
    await click(archiveButton);

    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();

    await click(findButton(document.body, "workbenchLifecycle.dialog.cancel"));

    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(archiveButton);
  });

  it.each([
    [
      "workspace_preservation_failed",
      "worktree could not be saved before removal",
    ],
    [
      "workspace_git_identity_invalid",
      "Configure user.name and user.email for the server user",
    ],
  ])(
    "explains %s after a refused drop without displaying server text",
    async (reason, expectedText) => {
      const fetchMock = vi.fn<FetchLike>(async () =>
        jsonResponse(
          { code: "CONFLICT", reason, message: "private server diagnostic" },
          { status: 409 },
        ),
      );

      vi.stubGlobal("fetch", fetchMock);
      renderActions(["drop"]);
      await click(findButton(document.body, "workbenchLifecycle.action.drop"));
      await click(
        findButton(document.body, "workbenchLifecycle.dialog.confirm"),
      );
      await flushPromises();

      expect(textOf(document.body)).toContain(expectedText);
      expect(textOf(document.body)).not.toContain("private server diagnostic");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(refreshMock).not.toHaveBeenCalled();
    },
  );

  it("requires a commit message before calling snapshot-commit", async () => {
    const fetchMock = vi.fn<FetchLike>(async () => metadataResponse(true));

    vi.stubGlobal("fetch", fetchMock);

    renderActions(["exportBranch"]);

    await click(
      findButton(document.body, "workbenchLifecycle.action.snapshotCommit"),
    );
    await flushPromises();
    await changeInput(findTextarea(document.body), "");

    const commitButton = findButton(
      document.body,
      "workbenchLifecycle.dialog.commit",
    );

    expect(commitButton.disabled).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("disables snapshot commit when the worktree is already clean", async () => {
    const fetchMock = vi.fn<FetchLike>(async () => metadataResponse(false));

    vi.stubGlobal("fetch", fetchMock);

    renderActions(["exportBranch"]);

    await click(
      findButton(document.body, "workbenchLifecycle.action.snapshotCommit"),
    );
    await flushPromises();

    expect(
      findButton(document.body, "workbenchLifecycle.dialog.commit").disabled,
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

    renderActions(["exportBranch"]);

    await click(
      findButton(document.body, "workbenchLifecycle.action.exportBranch"),
    );
    await flushPromises();
    await click(findButton(document.body, "workbenchLifecycle.dialog.push"));
    await flushPromises();

    expect(textOf(document.body)).toContain("current run state conflicts");
    expect(textOf(document.body)).not.toContain(
      "remote branch has newer commits",
    );
    expect(textOf(document.body)).not.toContain("Review the remote branch");

    await click(
      findButton(document.body, "workbenchLifecycle.dialog.forcePush"),
    );
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
    expect(textOf(document.body)).toContain("origin/maister/run-1");
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

    renderActions(["exportBranch"]);

    await click(
      findButton(document.body, "workbenchLifecycle.action.exportBranch"),
    );
    await flushPromises();
    await changeInput(findSelect(document.body), "backup");
    await changeInput(findInput(document.body), "bad..branch");

    expect(
      findButton(document.body, "workbenchLifecycle.dialog.handoff").disabled,
    ).toBe(true);
    expect(textOf(document.body)).toContain(
      "workbenchLifecycle.dialog.invalidBranch",
    );

    await changeInput(findInput(document.body), "maister/handoff/run-1");
    await click(findButton(document.body, "workbenchLifecycle.dialog.handoff"));
    await flushPromises();

    expect(textOf(document.body)).toContain("current run state conflicts");
    expect(textOf(document.body)).not.toContain("CONFLICT");

    await click(findButton(document.body, "workbenchLifecycle.dialog.handoff"));
    await flushPromises();

    expect(lastHandoffBody).toMatchObject({
      remote: "backup",
      handoffBranch: "maister/handoff/run-1",
    });
    expect(textOf(document.body)).toContain(
      "git -C /repo switch --track backup/maister/handoff/run-1",
    );

    await click(findButton(document.body, "workbenchLifecycle.dialog.copy"));

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
  it("has no inline Stop; the action-sheet carries stop, stop & archive, stop & drop", async () => {
    renderMenu({ runKind: "scratch", actions: ["stop"] });

    // Stop is no longer an inline button — it lives in the sheet.
    expect(document.body.querySelector('[data-testid="rail-stop"]')).toBeNull();

    await click(byTestId(document.body, "rail-menu-trigger"));

    const sheet = byTestId(document.body, "rail-action-sheet");

    expect(sheet.querySelector('[data-testid="menu-open"]')).not.toBeNull();
    expect(sheet.querySelector('[data-testid="menu-rename"]')).not.toBeNull();
    expect(sheet.querySelector('[data-testid="menu-stop"]')).not.toBeNull();
    expect(
      sheet.querySelector('[data-testid="menu-stopArchive"]'),
    ).not.toBeNull();
    expect(sheet.querySelector('[data-testid="menu-stopDrop"]')).not.toBeNull();
  });

  it("a writable agent run gets the same combined stop actions as flow and scratch", async () => {
    renderMenu({
      runKind: "agent",
      actions: ["stop"],
      workspaceAvailable: true,
      runHref: "/runs/run-1",
    });

    await click(byTestId(document.body, "rail-menu-trigger"));

    const sheet = byTestId(document.body, "rail-action-sheet");

    expect(sheet.querySelector('[data-testid="menu-stop"]')).not.toBeNull();
    expect(
      sheet.querySelector('[data-testid="menu-stopArchive"]'),
    ).not.toBeNull();
    expect(sheet.querySelector('[data-testid="menu-stopDrop"]')).not.toBeNull();
    expect(sheet.querySelector('[data-testid="menu-rename"]')).toBeNull();
  });

  it("an agent without a writable workspace gets only plain Stop", async () => {
    renderMenu({
      runKind: "agent",
      actions: ["stop"],
      workspaceAvailable: false,
    });

    await click(byTestId(document.body, "rail-menu-trigger"));

    const sheet = byTestId(document.body, "rail-action-sheet");

    expect(sheet.querySelector('[data-testid="menu-stop"]')).not.toBeNull();
    expect(sheet.querySelector('[data-testid="menu-stopArchive"]')).toBeNull();
    expect(sheet.querySelector('[data-testid="menu-stopDrop"]')).toBeNull();
  });

  it("menu Stop posts to the plain stop endpoint", async () => {
    const fetchMock = vi.fn<FetchLike>(async () => jsonResponse({ ok: true }));

    vi.stubGlobal("fetch", fetchMock);

    renderMenu({ runKind: "flow", actions: ["stop"] });

    await click(byTestId(document.body, "rail-menu-trigger"));
    await click(byTestId(document.body, "menu-stop"));
    await click(findButton(document.body, "workbenchLifecycle.dialog.confirm"));
    await flushPromises();

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/runs/run-1/stop",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("shows a terminal action-sheet (open, archive, drop) with no inline Stop", async () => {
    renderMenu({
      runKind: "flow",
      actions: ["archive", "drop", "exportBranch"],
    });

    expect(document.body.querySelector('[data-testid="rail-stop"]')).toBeNull();

    await click(byTestId(document.body, "rail-menu-trigger"));

    const sheet = byTestId(document.body, "rail-action-sheet");

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

    renderMenu({ runKind: "flow", actions: ["stop"] });

    await click(byTestId(document.body, "rail-menu-trigger"));
    await click(byTestId(document.body, "menu-stopArchive"));
    await click(findButton(document.body, "workbenchLifecycle.dialog.confirm"));
    await flushPromises();

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/runs/run-1/stop-archive",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("scratch stop & drop uses the shared lifecycle endpoint", async () => {
    const fetchMock = vi.fn<FetchLike>(async () => jsonResponse({ ok: true }));

    vi.stubGlobal("fetch", fetchMock);

    renderMenu({ runKind: "scratch", actions: ["stop"] });

    await click(byTestId(document.body, "rail-menu-trigger"));
    await click(byTestId(document.body, "menu-stopDrop"));
    await click(findButton(document.body, "workbenchLifecycle.dialog.confirm"));
    await flushPromises();

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/runs/run-1/stop-drop",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("rename posts the new name to the scratch rename endpoint", async () => {
    const fetchMock = vi.fn<FetchLike>(async () => jsonResponse({ ok: true }));

    vi.stubGlobal("fetch", fetchMock);

    renderMenu({ runKind: "scratch", actions: ["stop"] });

    await click(byTestId(document.body, "rail-menu-trigger"));
    await click(byTestId(document.body, "menu-rename"));
    await changeInput(
      byTestId(document.body, "rename-input") as HTMLInputElement,
      "new name",
    );
    await click(byTestId(document.body, "rename-save"));
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

// ADR-181 D16 (RED 12): the run detail opens the git panel where it opened the
// Export dialog, and every git action on the rail/cards is a DEEP LINK into it
// — never a blind mutation from a menu (a publish needs a name, an update an
// `onto`).
describe("ADR-181 — git panel hosting and rail deep links", () => {
  function gitStateResponse(): Response {
    return jsonResponse({
      runId: "run-1",
      runKind: "flow",
      runStatus: "Failed",
      internalBranch: "maister/run-1",
      publicBranch: null,
      publishedRemote: null,
      publishedAt: null,
      suggestedPublicBranch: "feature/KEY-7-x",
      upstream: null,
      remotes: ["origin"],
      worktreePresent: true,
      workspaceRemoved: false,
      head: "a".repeat(40),
      targetHead: "b".repeat(40),
      dirty: { tracked: 0, untracked: 0 },
      unpushedCommits: null,
      aheadBehind: { base: null, target: null, published: null },
      publishedRemoteHead: null,
      remoteReachable: true,
      pr: null,
      busy: null,
      hasActiveAssignment: false,
      hasLiveSharedSibling: false,
      reattachSources: { local: null, published: null, archive: null },
      rescueRefs: [],
      actions: [],
      prDefaults: null,
      commands: { checkout: [], restoreRescue: null },
      warnings: [],
    });
  }

  it("opens the git panel from the run detail and reads git-state, not handoff-metadata", async () => {
    const fetchMock = vi.fn<FetchLike>(async () => gitStateResponse());

    vi.stubGlobal("fetch", fetchMock);

    const container = document.createElement("div");
    const root = createRoot(container);

    document.body.appendChild(container);
    roots.push(root);
    act(() => {
      root.render(
        createElement(WorkbenchLifecycleActions, {
          runId: "run-1",
          runKind: "flow",
          actions: ["archive", "drop", "exportBranch", "snapshotCommit"],
          variant: "detail",
        }),
      );
    });

    await click(byTestId(document.body, "workbench-git-open"));
    await flushPromises();

    expect(
      document.body.querySelector('[data-testid="git-panel"]'),
    ).not.toBeNull();
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      "/api/runs/run-1/git-state",
    ]);
  });

  it("opens the panel on load when the URL names a git section", async () => {
    searchParams = new URLSearchParams("git=publish");
    vi.stubGlobal(
      "fetch",
      vi.fn<FetchLike>(async () => gitStateResponse()),
    );

    const container = document.createElement("div");
    const root = createRoot(container);

    document.body.appendChild(container);
    roots.push(root);
    act(() => {
      root.render(
        createElement(WorkbenchLifecycleActions, {
          runId: "run-1",
          runKind: "flow",
          actions: ["exportBranch"],
          variant: "detail",
        }),
      );
    });
    await flushPromises();

    expect(
      document.body.querySelector('[data-testid="git-panel-section-publish"]'),
    ).not.toBeNull();
  });

  it("renders every git action on the rail as a link into the run's git panel", async () => {
    renderMenu({
      runKind: "flow",
      runHref: "/runs/run-1",
      actions: [
        "archive",
        "drop",
        "exportBranch",
        "snapshotCommit",
        "discardChanges",
        "update",
        "openPr",
        "finalizePr",
        "reattach",
      ],
    });

    await click(byTestId(document.body, "rail-menu-trigger"));

    const sheet = byTestId(document.body, "rail-action-sheet");
    const expected: Record<string, string> = {
      snapshotCommit: "/runs/run-1?git=tree",
      discardChanges: "/runs/run-1?git=tree",
      exportBranch: "/runs/run-1?git=publish",
      update: "/runs/run-1?git=update",
      openPr: "/runs/run-1?git=pr",
      finalizePr: "/runs/run-1?git=pr",
      reattach: "/runs/run-1?git=reattach",
    };

    for (const [id, href] of Object.entries(expected)) {
      const item = sheet.querySelector(`[data-testid="menu-${id}"]`);

      expect(item?.tagName).toBe("A");
      expect(item?.getAttribute("href")).toBe(href);
    }
  });

  it("deep-links a scratch run's git actions to the scratch detail", async () => {
    renderMenu({
      runKind: "scratch",
      runHref: "/scratch-runs/run-1",
      actions: ["archive", "exportBranch"],
    });

    await click(byTestId(document.body, "rail-menu-trigger"));

    expect(
      byTestId(document.body, "menu-exportBranch").getAttribute("href"),
    ).toBe("/scratch-runs/run-1?git=publish");
  });
});

// ADR-181 D17 (RED 13): archive/drop show what exists on no remote before the
// destructive op, and "Publish, then archive" archives only after the publish
// answered 200.
describe("ADR-181 — unpushed-work guard on archive", () => {
  function unpushedState(): Response {
    return jsonResponse({
      runId: "run-1",
      runKind: "flow",
      runStatus: "Failed",
      internalBranch: "maister/run-1",
      publicBranch: "feature/KEY-7-x",
      publishedRemote: "origin",
      publishedAt: new Date().toISOString(),
      suggestedPublicBranch: "feature/KEY-7-x",
      upstream: { remote: "origin", branch: "feature/KEY-7-x" },
      remotes: ["origin"],
      worktreePresent: true,
      workspaceRemoved: false,
      head: "a".repeat(40),
      targetHead: "b".repeat(40),
      dirty: { tracked: 1, untracked: 1 },
      unpushedCommits: 2,
      aheadBehind: {
        base: null,
        target: null,
        published: { ahead: 2, behind: 0 },
      },
      publishedRemoteHead: "c".repeat(40),
      remoteReachable: true,
      pr: null,
      busy: null,
      hasActiveAssignment: false,
      hasLiveSharedSibling: false,
      reattachSources: { local: null, published: null, archive: null },
      rescueRefs: [],
      actions: [],
      prDefaults: null,
      commands: { checkout: [], restoreRescue: null },
      warnings: [],
    });
  }

  it("names the unpushed commits and dirty files, then publishes before archiving", async () => {
    const fetchMock = vi.fn<FetchLike>(async (input) =>
      String(input).endsWith("/git-state")
        ? unpushedState()
        : jsonResponse({ ok: true }),
    );

    vi.stubGlobal("fetch", fetchMock);
    renderActions(["archive", "drop", "exportBranch"]);

    await click(findButton(document.body, "workbenchLifecycle.action.archive"));
    await flushPromises();

    const guard = byTestId(document.body, "lifecycle-unpushed");

    expect(textOf(guard)).toContain("2");
    await click(byTestId(document.body, "lifecycle-publish-then-remove"));
    await flushPromises();

    const posted = fetchMock.mock.calls
      .filter(([, init]) => init?.method === "POST")
      .map(([url, init]) => [
        String(url),
        JSON.parse(String(init?.body ?? "{}")),
      ]);

    expect(posted.map(([url]) => url)).toEqual([
      "/api/runs/run-1/export-branch",
      "/api/runs/run-1/archive",
    ]);
    expect(posted[0][1]).toMatchObject({
      remote: "origin",
      snapshotDirty: true,
    });
  });

  it("does not archive when the publish is refused", async () => {
    const fetchMock = vi.fn<FetchLike>(async (input) => {
      const url = String(input);

      if (url.endsWith("/git-state")) return unpushedState();
      if (url.endsWith("/export-branch")) {
        return jsonResponse(
          {
            code: "CONFLICT",
            message: "x",
            pushRejected: "non_fast_forward",
            canForce: true,
          },
          { status: 409 },
        );
      }

      return jsonResponse({ ok: true });
    });

    vi.stubGlobal("fetch", fetchMock);
    renderActions(["archive", "drop", "exportBranch"]);

    await click(findButton(document.body, "workbenchLifecycle.action.archive"));
    await flushPromises();
    await click(byTestId(document.body, "lifecycle-publish-then-remove"));
    await flushPromises();

    expect(
      fetchMock.mock.calls.some(([url]) => String(url).endsWith("/archive")),
    ).toBe(false);
  });
});
