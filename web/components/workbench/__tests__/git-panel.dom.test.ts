// @vitest-environment jsdom

// ADR-181 D16 (RED 12): the run git panel. Every button is driven by the
// server's `actions[]`; every mutation re-reads git-state; typed input survives
// a refresh tick; errors resolve from `code` + `details.reason` only.

import type { ComponentProps } from "react";

import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// One cached translator per namespace: a fresh function per render would be a
// changing hook dependency and re-fire every effect that closes over it.
vi.mock("next-intl", () => {
  const cache = new Map<string, (key: string, values?: unknown) => string>();

  return {
    useTranslations: (namespace: string) => {
      let t = cache.get(namespace);

      if (!t) {
        t = (key: string, values?: unknown) =>
          values === undefined
            ? `${namespace}.${key}`
            : `${namespace}.${key} ${JSON.stringify(values)}`;
        cache.set(namespace, t);
      }

      return t;
    },
  };
});

const refreshMock = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: refreshMock }),
}));

const feedbackSuccess = vi.fn();
const feedbackError = vi.fn();

vi.mock("@/components/feedback/feedback-provider", () => ({
  useFeedback: () => ({ success: feedbackSuccess, error: feedbackError }),
}));

import { WorkbenchGitPanel } from "@/components/workbench/git-panel";

type FetchCall = { url: string; method: string; body: unknown };

const RUN = "run-1";
const INTERNAL = "maister/task-1/attempt-1";
const PUBLIC = "feature/ABC-1-fix-it";
const ALL_IDS = [
  "stop",
  "archive",
  "drop",
  "exportBranch",
  "snapshotCommit",
  "discardChanges",
  "update",
  "openPr",
  "finalizePr",
  "reattach",
] as const;

type ActionId = (typeof ALL_IDS)[number];

function actions(
  enabled: readonly ActionId[],
  reason = "unsupported-status",
): Array<{ id: ActionId; enabled: boolean; disabledReason: string | null }> {
  return ALL_IDS.map((id) =>
    enabled.includes(id)
      ? { id, enabled: true, disabledReason: null }
      : { id, enabled: false, disabledReason: reason },
  );
}

function gitState(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    runId: RUN,
    runKind: "flow",
    runStatus: "Failed",
    internalBranch: INTERNAL,
    publicBranch: null,
    publishedRemote: null,
    publishedAt: null,
    suggestedPublicBranch: PUBLIC,
    upstream: null,
    remotes: ["origin"],
    worktreePresent: true,
    workspaceRemoved: false,
    head: "a".repeat(40),
    targetHead: "b".repeat(40),
    dirty: { tracked: 1, untracked: 1 },
    unpushedCommits: null,
    aheadBehind: {
      base: { ahead: 1, behind: 0 },
      target: null,
      published: null,
    },
    publishedRemoteHead: null,
    remoteReachable: true,
    pr: null,
    busy: null,
    hasActiveAssignment: false,
    hasLiveSharedSibling: false,
    reattachSources: { local: null, published: null, archive: null },
    rescueRefs: [],
    actions: actions([
      "archive",
      "drop",
      "exportBranch",
      "snapshotCommit",
      "discardChanges",
      "update",
    ]),
    prDefaults: {
      title: "ABC-1: Fix it",
      body: "http://localhost/runs/run-1",
      targetBranch: "main",
    },
    commands: { checkout: [], restoreRescue: null },
    warnings: [],
    ...over,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

let calls: FetchCall[];
let states: Array<Record<string, unknown>>;
let mutation: (call: FetchCall) => Response;

function installFetch(): void {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const call: FetchCall = {
        url,
        method,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      };

      calls.push(call);

      if (method === "GET" && url.endsWith(`/api/runs/${RUN}/git-state`)) {
        return json(states.length > 1 ? states.shift()! : states[0]);
      }

      return mutation(call);
    }),
  );
}

const roots: Root[] = [];

function render(props: Record<string, unknown> = {}): {
  rerender: (next: Record<string, unknown>) => void;
} {
  const container = document.createElement("div");
  const root = createRoot(container);

  document.body.appendChild(container);
  roots.push(root);

  const base = { runId: RUN, runKind: "flow", refreshTick: 0 };
  const draw = (over: Record<string, unknown>) => {
    const merged = { ...base, ...over } as unknown as ComponentProps<
      typeof WorkbenchGitPanel
    >;

    act(() => {
      root.render(createElement(WorkbenchGitPanel, merged));
    });
  };

  draw(props);

  return { rerender: draw };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

function byTestId<T extends Element = HTMLElement>(id: string): T | null {
  return document.body.querySelector<T>(`[data-testid="${id}"]`);
}

function must<T extends Element = HTMLElement>(id: string): T {
  const el = byTestId<T>(id);

  if (!el) throw new Error(`missing [data-testid="${id}"]`);

  return el;
}

async function click(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await settle();
}

async function type(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    const proto =
      el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;

    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function gets(): FetchCall[] {
  return calls.filter((c) => c.method === "GET");
}

function posts(): FetchCall[] {
  return calls.filter((c) => c.method === "POST");
}

beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  refreshMock.mockReset();
  feedbackSuccess.mockReset();
  feedbackError.mockReset();
  states = [gitState()];
  mutation = () => json({ ok: true });
  installFetch();
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn() },
  });
});

afterEach(() => {
  for (const root of roots) act(() => root.unmount());
  roots.length = 0;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("WorkbenchGitPanel", () => {
  it("reads git-state exactly once on open and shows the internal branch", async () => {
    render();
    await settle();

    expect(gets()).toHaveLength(1);
    expect(must("git-panel").textContent).toContain(INTERNAL);
  });

  it("disables every action while another writer owns the worktree, with the reason", async () => {
    states = [
      gitState({
        busy: { name: "sync", claimedAt: new Date().toISOString() },
        actions: actions([], "busy"),
      }),
    ];
    render();
    await settle();

    expect(must("git-panel-busy").textContent).toContain("sync");
    for (const id of ["snapshotCommit", "discardChanges", "exportBranch"]) {
      const button = must<HTMLButtonElement>(`git-panel-action-${id}`);

      expect(button.disabled).toBe(true);
      expect(button.title).toBe("workbenchGit.disabledReason.busy");
    }
  });

  it("commits a dirty tree, then re-reads git-state and refreshes the route", async () => {
    render();
    await settle();

    await click(must("git-panel-action-snapshotCommit"));
    await type(
      must<HTMLTextAreaElement>("git-panel-commit-message"),
      "wip: save",
    );
    await click(must("git-panel-commit-submit"));

    expect(posts()).toEqual([
      {
        url: `/api/runs/${RUN}/snapshot-commit`,
        method: "POST",
        body: { commitMessage: "wip: save" },
      },
    ]);
    expect(gets()).toHaveLength(2);
    expect(refreshMock).toHaveBeenCalledTimes(1);
    expect(feedbackSuccess).toHaveBeenCalledTimes(1);
  });

  // Migrated from the removed Export dialog (lifecycle-actions.dom.test.ts):
  // a commit needs a message, and a clean tree has nothing to commit/discard.
  it("keeps Commit's submit disabled until a message is typed", async () => {
    render();
    await settle();

    await click(must("git-panel-action-snapshotCommit"));

    const submit = must<HTMLButtonElement>("git-panel-commit-submit");

    expect(submit.disabled).toBe(true);
    await type(must<HTMLTextAreaElement>("git-panel-commit-message"), "   ");
    expect(submit.disabled).toBe(true);
    expect(posts()).toHaveLength(0);
  });

  it("disables Commit and Discard on a clean tree, naming why", async () => {
    states = [gitState({ dirty: { tracked: 0, untracked: 0 } })];
    render();
    await settle();

    for (const id of ["snapshotCommit", "discardChanges"]) {
      const button = must<HTMLButtonElement>(`git-panel-action-${id}`);

      expect(button.disabled).toBe(true);
      expect(button.title).toBe("workbenchGit.hint.cleanTree");
    }
  });

  it("discards through the destructive confirmation and shows the rescue ref", async () => {
    mutation = (call) =>
      call.url.endsWith("/discard-changes")
        ? json({
            ok: true,
            runId: RUN,
            rescueRef: `refs/maister/rescue/${RUN}/1`,
            sha: "c".repeat(40),
            restoreCommand: `git -C /wt restore --source=refs/maister/rescue/${RUN}/1 -- .`,
          })
        : json({ ok: true });
    render();
    await settle();

    await click(must("git-panel-action-discardChanges"));
    expect(posts()).toHaveLength(0);
    await click(must("git-panel-discard-confirm"));

    expect(posts()).toEqual([
      { url: `/api/runs/${RUN}/discard-changes`, method: "POST", body: {} },
    ]);
    expect(must("git-panel-rescue-result").textContent).toContain(
      `refs/maister/rescue/${RUN}/1`,
    );
  });

  it("pre-fills the public name from the template and sends it only when edited", async () => {
    states = [gitState({ dirty: { tracked: 0, untracked: 0 } })];
    render();
    await settle();

    const name = must<HTMLInputElement>("git-panel-name");

    expect(name.value).toBe(PUBLIC);

    await click(must("git-panel-action-exportBranch"));
    expect(posts()[0]).toEqual({
      url: `/api/runs/${RUN}/export-branch`,
      method: "POST",
      body: { remote: "origin", snapshotDirty: false, force: false },
    });

    await type(name, "feature/hand-picked");
    await click(must("git-panel-action-exportBranch"));
    expect(posts()[1].body).toEqual({
      remote: "origin",
      branchName: "feature/hand-picked",
      snapshotDirty: false,
      force: false,
    });
  });

  it("hides the name field once an upstream fixes the public name, and shows it in the chip", async () => {
    states = [
      gitState({
        publicBranch: PUBLIC,
        publishedRemote: "origin",
        publishedAt: new Date().toISOString(),
        upstream: { remote: "origin", branch: PUBLIC },
      }),
    ];
    render();
    await settle();

    expect(byTestId("git-panel-name")).toBeNull();
    expect(must("git-panel-public-chip").textContent).toContain(PUBLIC);
  });

  it("offers force only after a non-fast-forward refusal, then retries with force", async () => {
    let first = true;

    mutation = (call) => {
      if (call.url.endsWith("/export-branch") && first) {
        first = false;

        return json(
          {
            code: "CONFLICT",
            message: "server text",
            pushRejected: "non_fast_forward",
            canForce: true,
          },
          409,
        );
      }

      return json({ ok: true, publishedBranch: PUBLIC });
    };
    states = [gitState({ dirty: { tracked: 0, untracked: 0 } })];
    render();
    await settle();

    expect(byTestId("git-panel-force")).toBeNull();
    await click(must("git-panel-action-exportBranch"));

    const force = must<HTMLInputElement>("git-panel-force");

    expect(document.body.textContent).not.toContain("server text");
    await click(force);
    await click(must("git-panel-action-exportBranch"));
    expect(posts()[1].body).toMatchObject({ force: true });
  });

  it("disables publish on a dirty tree and names Commit and Discard as the way out", async () => {
    render();
    await settle();

    const publish = must<HTMLButtonElement>("git-panel-action-exportBranch");

    expect(publish.disabled).toBe(true);
    expect(publish.title).toBe("workbenchGit.hint.commitOrDiscardFirst");
  });

  it("renders only the reattach section when the worktree is not usable", async () => {
    states = [
      gitState({
        worktreePresent: false,
        workspaceRemoved: true,
        head: null,
        dirty: null,
        reattachSources: {
          local: "d".repeat(40),
          published: null,
          archive: null,
        },
        actions: actions(["reattach"], "removed-workspace"),
      }),
    ];
    render();
    await settle();

    expect(must("git-panel-section-reattach")).toBeTruthy();
    for (const section of ["tree", "publish", "update", "pr"]) {
      expect(byTestId(`git-panel-section-${section}`)).toBeNull();
    }
    expect(must<HTMLButtonElement>("git-panel-action-reattach").disabled).toBe(
      false,
    );
  });

  it("keeps a typed commit message across a git-state refresh tick", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const view = render();

    await settle();
    await click(must("git-panel-action-snapshotCommit"));
    await type(
      must<HTMLTextAreaElement>("git-panel-commit-message"),
      "half typed",
    );

    view.rerender({ refreshTick: 1 });
    await act(async () => {
      vi.advanceTimersByTime(1_000);
    });
    await settle();

    expect(gets()).toHaveLength(2);
    expect(must<HTMLTextAreaElement>("git-panel-commit-message").value).toBe(
      "half typed",
    );
  });

  it("resolves a refusal from details.reason, never from the server message", async () => {
    mutation = () =>
      json(
        {
          code: "PRECONDITION",
          message: "private server diagnostic",
          details: { reason: "clean_worktree" },
        },
        409,
      );
    render();
    await settle();

    await click(must("git-panel-action-discardChanges"));
    await click(must("git-panel-discard-confirm"));

    expect(must("git-panel-error").textContent).toBe(
      "workbenchGit.errors.clean_worktree",
    );
    expect(document.body.textContent).not.toContain(
      "private server diagnostic",
    );
  });
});
