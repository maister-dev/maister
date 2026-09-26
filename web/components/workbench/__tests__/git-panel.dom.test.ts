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
    publishedTrackingHead: null,
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
// The status every git-state read answers with (200 serves `states`).
let gitStateStatus: number;

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
        if (gitStateStatus !== 200) {
          return json(
            { code: gitStateStatus === 403 ? "UNAUTHORIZED" : "CRASH" },
            gitStateStatus,
          );
        }

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
  gitStateStatus = 200;
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

  // The route answers 403 below `recoverRun`: a viewer sees why, not an error.
  it("shows a viewer the members-only state when git-state answers 403", async () => {
    gitStateStatus = 403;
    render();
    await settle();

    expect(must("git-panel-members-only").textContent).toBe(
      "workbenchGit.membersOnly",
    );
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(byTestId("git-panel-section-tree")).toBeNull();
  });

  // D3: a sub-read that degraded is named, so a blank count reads as "could
  // not read", never as "nothing there".
  it("names the git facts the server could not read", async () => {
    states = [gitState({ warnings: ["remotes", "aheadBehind.target"] })];
    render();
    await settle();

    expect(must("git-panel-warnings").textContent).toBe(
      `workbenchGit.warnings.note ${JSON.stringify({
        facts:
          "workbenchGit.warnings.fact.remotes, workbenchGit.warnings.fact.aheadBehind.target",
      })}`,
    );
  });

  it("shows no warning when every git fact was read", async () => {
    render();
    await settle();

    expect(byTestId("git-panel-warnings")).toBeNull();
  });

  it("still reads any other failed read as a load failure", async () => {
    gitStateStatus = 500;
    render();
    await settle();

    expect(byTestId("git-panel-members-only")).toBeNull();
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      "workbenchGit.loadFailed",
    );
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

  // ADR-181 D4: a force replaces someone's commits, so it is confirmed in the
  // shared dialog — naming the ref, the head it replaces and an open PR — and
  // the retry leases exactly that head.
  describe("a force publish", () => {
    const REMOTE_HEAD = "d".repeat(40);

    function refuseOnce(over: Record<string, unknown> = {}): void {
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
              remoteHead: REMOTE_HEAD,
              remoteRef: `origin/${PUBLIC}`,
              ...over,
            },
            409,
          );
        }

        return json({ ok: true, publishedBranch: PUBLIC });
      };
    }

    it("is confirmed naming the ref and the head it replaces, then leases that head", async () => {
      refuseOnce();
      states = [gitState({ dirty: { tracked: 0, untracked: 0 } })];
      render();
      await settle();

      await click(must("git-panel-action-exportBranch"));

      const dialog = must("git-panel-force-dialog");

      expect(dialog.textContent).toContain(`origin/${PUBLIC}`);
      expect(dialog.textContent).toContain(REMOTE_HEAD.slice(0, 12));
      expect(byTestId("git-panel-force-pr")).toBeNull();
      expect(document.body.textContent).not.toContain("server text");
      expect(posts()).toHaveLength(1);

      await click(must("git-panel-force-confirm"));

      expect(posts()[1].body).toEqual({
        remote: "origin",
        snapshotDirty: false,
        force: true,
        expectedHead: REMOTE_HEAD,
      });
      expect(byTestId("git-panel-force-dialog")).toBeNull();
    });

    it("names the open pull request the force rewrites", async () => {
      refuseOnce();
      states = [
        gitState({
          dirty: { tracked: 0, untracked: 0 },
          pr: {
            url: "https://example.test/pr/7",
            number: 7,
            state: "open",
            hasConflicts: null,
          },
        }),
      ];
      render();
      await settle();

      await click(must("git-panel-action-exportBranch"));

      expect(must("git-panel-force-pr").textContent).toContain('"number":7');
    });

    it("re-asks naming the new head when the remote moved on after the confirmation", async () => {
      const NEWER = "e".repeat(40);
      const refusals = [REMOTE_HEAD, NEWER];

      mutation = (call) => {
        const head = call.url.endsWith("/export-branch")
          ? refusals.shift()
          : undefined;

        return head
          ? json(
              {
                code: "CONFLICT",
                pushRejected: "non_fast_forward",
                canForce: true,
                remoteHead: head,
                remoteRef: `origin/${PUBLIC}`,
              },
              409,
            )
          : json({ ok: true, publishedBranch: PUBLIC });
      };
      states = [gitState({ dirty: { tracked: 0, untracked: 0 } })];
      render();
      await settle();

      await click(must("git-panel-action-exportBranch"));
      await click(must("git-panel-force-confirm"));

      expect(must("git-panel-force-dialog").textContent).toContain(
        NEWER.slice(0, 12),
      );

      await click(must("git-panel-force-confirm"));

      expect(posts().map((call) => (call.body as any).expectedHead)).toEqual([
        undefined,
        REMOTE_HEAD,
        NEWER,
      ]);
    });

    it("sends nothing when the operator cancels", async () => {
      refuseOnce();
      states = [gitState({ dirty: { tracked: 0, untracked: 0 } })];
      render();
      await settle();

      await click(must("git-panel-action-exportBranch"));
      await click(must("git-panel-force-cancel"));

      expect(byTestId("git-panel-force-dialog")).toBeNull();
      expect(posts()).toHaveLength(1);
    });

    it("offers no force when the refusal names no remote head", async () => {
      refuseOnce({ remoteHead: null });
      states = [gitState({ dirty: { tracked: 0, untracked: 0 } })];
      render();
      await settle();

      await click(must("git-panel-action-exportBranch"));

      expect(byTestId("git-panel-force-dialog")).toBeNull();
      expect(must("git-panel-error").textContent).toBe(
        "workbenchGit.errors.non_fast_forward",
      );
    });
  });

  // web/CLAUDE.md: icon + label for actions; a disclosure says whether it is open.
  it("renders the Handoff toggle with its icon and its open state", async () => {
    // The opened form reads its metadata (`HandoffMetadataResponse`).
    mutation = () =>
      json({
        ok: true,
        runId: RUN,
        branch: INTERNAL,
        dirty: false,
        remotes: ["origin"],
        defaultRemote: "origin",
        suggestedHandoffBranch: `maister/handoff/${RUN}`,
        checkoutCommands: [],
      });
    render();
    await settle();

    const toggle = must<HTMLButtonElement>("git-panel-handoff-open");

    expect(toggle.querySelector("svg")).not.toBeNull();
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    await click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
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

  it("lists the rescue refs already written, in the order git-state serves (newest first)", async () => {
    states = [
      gitState({
        rescueRefs: [
          {
            ref: `refs/maister/rescue/${RUN}/2`,
            sha: "e".repeat(40),
            createdAt: "2026-09-23T10:00:00.000Z",
          },
          {
            ref: `refs/maister/rescue/${RUN}/1`,
            sha: "f".repeat(40),
            createdAt: "2026-09-22T10:00:00.000Z",
          },
        ],
      }),
    ];
    render();
    await settle();

    const items = Array.from(
      must("git-panel-rescue-refs").querySelectorAll("li"),
      (li) => li.querySelector("code")?.textContent,
    );

    expect(items).toEqual([
      `refs/maister/rescue/${RUN}/2`,
      `refs/maister/rescue/${RUN}/1`,
    ]);
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

// ADR-181 D9 (RED 12 extension): the Update section. The ref choice carries
// its own ahead/behind; the AI resolver exists only in Review, where its
// Review→Running CAS can run; a conflict shows its paths and is not a success.
describe("WorkbenchGitPanel — Update", () => {
  const CLEAN = { tracked: 0, untracked: 0 };
  const SYNCED = {
    attemptId: "att-1",
    outcome: "synced",
    behind: 1,
    pushed: false,
    conflictedFiles: [],
  };

  async function choose(el: HTMLSelectElement, value: string): Promise<void> {
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLSelectElement.prototype,
        "value",
      )!.set!.call(el, value);
      el.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }

  it("offers each ref with its own ahead/behind, the publication only once published", async () => {
    states = [
      gitState({
        dirty: CLEAN,
        aheadBehind: {
          base: { ahead: 2, behind: 1 },
          target: { ahead: 2, behind: 3 },
          published: null,
        },
      }),
    ];
    render();
    await settle();

    const target = must<HTMLInputElement>("git-panel-update-onto-target");

    expect(target.checked).toBe(true);
    expect(target.closest("label")!.textContent).toContain(
      '{"ahead":2,"behind":3}',
    );
    expect(
      must("git-panel-update-onto-base").closest("label")!.textContent,
    ).toContain('{"ahead":2,"behind":1}');
    expect(
      must<HTMLInputElement>("git-panel-update-onto-published").disabled,
    ).toBe(true);
  });

  it("has no AI resolver outside Review and always sends agent:false there", async () => {
    states = [gitState({ runStatus: "Failed", dirty: CLEAN })];
    mutation = (call) =>
      call.url.endsWith("/sync") ? json(SYNCED) : json({ ok: true });
    render();
    await settle();

    expect(byTestId("git-panel-update-agent")).toBeNull();
    expect(byTestId("git-panel-update-runner")).toBeNull();
    await click(must("git-panel-update-onto-base"));
    await click(must("git-panel-action-update"));

    expect(posts()).toEqual([
      {
        url: `/api/runs/${RUN}/sync`,
        method: "POST",
        body: { onto: "base", strategy: "rebase", push: false, agent: false },
      },
    ]);
    expect(feedbackSuccess).toHaveBeenCalledTimes(1);
    expect(refreshMock).toHaveBeenCalledTimes(1);
  });

  it("offers the resolver in Review, on by default, with the runner and the project strategy", async () => {
    states = [
      gitState({
        runStatus: "Review",
        dirty: CLEAN,
        publicBranch: PUBLIC,
        publishedRemote: "origin",
        publishedAt: new Date().toISOString(),
        upstream: { remote: "origin", branch: PUBLIC },
        aheadBehind: {
          base: null,
          target: { ahead: 1, behind: 0 },
          published: { ahead: 0, behind: 1 },
        },
      }),
    ];
    mutation = (call) =>
      call.url.endsWith("/sync") ? json(SYNCED) : json({ ok: true });
    render({
      syncDefaults: {
        strategy: "merge",
        runnerOptions: [{ id: "runner-1", label: "claude · sonnet" }],
        defaultRunnerId: null,
      },
    });
    await settle();

    expect(must<HTMLInputElement>("git-panel-update-agent").checked).toBe(true);
    expect(must<HTMLSelectElement>("git-panel-update-strategy").value).toBe(
      "merge",
    );
    // A published branch pushes by default — the server's `push ?? published`.
    expect(must<HTMLInputElement>("git-panel-update-push").checked).toBe(true);

    await choose(
      must<HTMLSelectElement>("git-panel-update-runner"),
      "runner-1",
    );
    await click(must("git-panel-update-onto-published"));
    await click(must("git-panel-action-update"));

    expect(posts()[0].body).toEqual({
      onto: "published",
      strategy: "merge",
      push: true,
      agent: true,
      runnerId: "runner-1",
    });
  });

  it("names a conflict's paths and does not report it as a success", async () => {
    states = [gitState({ dirty: CLEAN })];
    mutation = (call) =>
      call.url.endsWith("/sync")
        ? json({
            ...SYNCED,
            outcome: "conflict",
            behind: 2,
            conflictedFiles: ["conf.txt", "src/app.ts"],
          })
        : json({ ok: true });
    render();
    await settle();

    await click(must("git-panel-action-update"));

    const result = must("git-panel-update-result");

    expect(result.textContent).toContain(
      "workbenchGit.update.outcome.conflict",
    );
    expect(result.textContent).toContain("conf.txt");
    expect(result.textContent).toContain("src/app.ts");
    expect(feedbackSuccess).not.toHaveBeenCalled();
  });

  // D3/Q3: the one network read exists to say the publication moved on the
  // remote since the last fetch (the operator's own push, from a laptop).
  it("says the remote moved only when the ls-remote head differs from the tracking ref", async () => {
    const published = {
      dirty: CLEAN,
      publicBranch: PUBLIC,
      publishedRemote: "origin",
      publishedTrackingHead: "c".repeat(40),
    };

    states = [gitState({ ...published, publishedRemoteHead: "c".repeat(40) })];
    render();
    await settle();

    expect(byTestId("git-panel-update-remote-moved")).toBeNull();

    document.body.replaceChildren();
    states = [gitState({ ...published, publishedRemoteHead: "d".repeat(40) })];
    render();
    await settle();

    expect(must("git-panel-update-remote-moved").textContent).toBe(
      "workbenchGit.update.remoteMoved",
    );
  });

  it("blocks the update on a dirty tree, naming Commit and Discard", async () => {
    render();
    await settle();

    const update = must<HTMLButtonElement>("git-panel-action-update");

    expect(update.disabled).toBe(true);
    expect(update.title).toBe("workbenchGit.hint.commitOrDiscardFirst");
  });

  // ADR-181 (C): the update's push would drop commits only the publication has
  // (a reviewer's fixup). The server refuses before anything moves; the panel
  // offers bringing them in first, or overwriting exactly the head it named.
  describe("an update that would drop the publication's commits", () => {
    const HEAD = "d".repeat(40);
    const PUBLISHED = {
      dirty: CLEAN,
      publicBranch: PUBLIC,
      publishedRemote: "origin",
      publishedAt: new Date().toISOString(),
      upstream: { remote: "origin", branch: PUBLIC },
      aheadBehind: {
        base: null,
        target: { ahead: 1, behind: 2 },
        published: { ahead: 1, behind: 1 },
      },
    };

    function diverged(head: string | null, count: number | null = 2) {
      return json(
        {
          code: "CONFLICT",
          message: "server text",
          details: { reason: "publication_diverged" },
          remoteHead: head,
          remoteRef: `origin/${PUBLIC}`,
          remoteOnlyCommits: count,
        },
        409,
      );
    }

    // The first `refusals.length` updates are refused with those heads.
    function refuse(...refusals: Array<string | null>): void {
      mutation = (call) => {
        if (!call.url.endsWith("/sync")) return json({ ok: true });
        if (refusals.length > 0) return diverged(refusals.shift()!);

        return json(SYNCED);
      };
    }

    it("asks first, naming the ref, the head and how many commits would leave", async () => {
      refuse(HEAD);
      states = [gitState(PUBLISHED)];
      render();
      await settle();

      await click(must("git-panel-action-update"));

      const dialog = must("git-panel-diverged-dialog");

      expect(dialog.textContent).toContain(
        `"ref":"origin/${PUBLIC}","head":"${HEAD.slice(0, 12)}","count":2`,
      );
      expect(must("git-panel-diverged-confirm").textContent).toContain(
        '{"count":2}',
      );
      expect(byTestId("git-panel-diverged-pr")).toBeNull();
      expect(must("git-panel-error").textContent).toBe(
        "workbenchGit.errors.publication_diverged",
      );
      expect(document.body.textContent).not.toContain("server text");
      expect(posts()).toHaveLength(1);
    });

    it("brings those commits in first — the same update onto the publication", async () => {
      refuse(HEAD);
      states = [gitState(PUBLISHED)];
      render();
      await settle();

      await click(must("git-panel-action-update"));
      await click(must("git-panel-diverged-onto"));

      expect(posts().map((call) => call.body)).toEqual([
        { onto: "target", strategy: "rebase", push: true, agent: false },
        { onto: "published", strategy: "rebase", push: true, agent: false },
      ]);
      expect(byTestId("git-panel-diverged-dialog")).toBeNull();
      expect(
        must<HTMLInputElement>("git-panel-update-onto-published").checked,
      ).toBe(true);
    });

    it("overwrites exactly the head it named, and re-asks naming a newer one", async () => {
      const NEWER = "e".repeat(40);

      refuse(HEAD, NEWER);
      states = [gitState(PUBLISHED)];
      render();
      await settle();

      await click(must("git-panel-action-update"));
      await click(must("git-panel-diverged-confirm"));

      expect(must("git-panel-diverged-dialog").textContent).toContain(
        NEWER.slice(0, 12),
      );

      await click(must("git-panel-diverged-confirm"));

      expect(
        posts().map((call) => (call.body as any).expectedRemoteHead),
      ).toEqual([undefined, HEAD, NEWER]);
      expect(posts()[2].body).toMatchObject({ onto: "target", push: true });
      expect(byTestId("git-panel-diverged-dialog")).toBeNull();
      expect(feedbackSuccess).toHaveBeenCalledTimes(1);
    });

    it("names the open pull request those commits would leave", async () => {
      refuse(HEAD);
      states = [
        gitState({
          ...PUBLISHED,
          pr: {
            url: "https://example.test/pr/7",
            number: 7,
            state: "open",
            hasConflicts: null,
          },
        }),
      ];
      render();
      await settle();

      await click(must("git-panel-action-update"));

      expect(must("git-panel-diverged-pr").textContent).toContain('"number":7');
    });

    it("sends nothing when the operator cancels", async () => {
      refuse(HEAD);
      states = [gitState(PUBLISHED)];
      render();
      await settle();

      await click(must("git-panel-action-update"));
      await click(must("git-panel-diverged-cancel"));

      expect(byTestId("git-panel-diverged-dialog")).toBeNull();
      expect(posts()).toHaveLength(1);
    });

    it("offers no overwrite when the head moved while it was checked", async () => {
      mutation = (call) =>
        call.url.endsWith("/sync") ? diverged(null, null) : json({ ok: true });
      states = [gitState(PUBLISHED)];
      render();
      await settle();

      await click(must("git-panel-action-update"));

      expect(byTestId("git-panel-diverged-dialog")).toBeNull();
      expect(must("git-panel-error").textContent).toBe(
        "workbenchGit.errors.publication_diverged",
      );
    });
  });
});

// ADR-181 D11/D12 (RED 12 extension): the PR section. Open PR exists only once
// the branch is published and pre-fills from the server's defaults; a reused
// PR is reported honestly; Finalize follows the policy (pr-closed disables it)
// and, from Review, sends the target head the panel rendered — a drift refusal
// offers "Finalize anyway".
describe("WorkbenchGitPanel — Pull request", () => {
  const CLEAN = { tracked: 0, untracked: 0 };
  const PR_URL = "https://github.com/acme/app/pull/42";
  const OPENED = {
    ok: true,
    runId: RUN,
    url: PR_URL,
    number: 42,
    state: "open",
    reused: false,
    draft: true,
    targetBranch: "main",
  };

  function published(over: Record<string, unknown> = {}) {
    return gitState({
      dirty: CLEAN,
      publicBranch: PUBLIC,
      publishedRemote: "origin",
      upstream: { remote: "origin", branch: PUBLIC },
      actions: actions(["exportBranch", "update", "openPr"]),
      ...over,
    });
  }

  it("hides Open PR until the branch is published, and says why", async () => {
    states = [gitState({ dirty: CLEAN })];
    render();
    await settle();

    expect(byTestId("git-panel-action-openPr")).toBeNull();
    expect(must("git-panel-pr-unpublished").textContent).toBe(
      "workbenchGit.pr.publishFirst",
    );
    // Finalize is shown only while a PR is recorded.
    expect(byTestId("git-panel-action-finalizePr")).toBeNull();
  });

  it("opens the PR with the pre-filled title, body and target and the draft choice", async () => {
    states = [published()];
    mutation = () => json(OPENED);
    render();
    await settle();

    expect(must<HTMLInputElement>("git-panel-pr-title").value).toBe(
      "ABC-1: Fix it",
    );
    expect(must<HTMLTextAreaElement>("git-panel-pr-body").value).toBe(
      "http://localhost/runs/run-1",
    );
    expect(must<HTMLInputElement>("git-panel-pr-target").value).toBe("main");

    await click(must("git-panel-pr-draft"));
    await click(must("git-panel-action-openPr"));

    expect(posts()).toEqual([
      {
        url: `/api/runs/${RUN}/pr`,
        method: "POST",
        body: {
          title: "ABC-1: Fix it",
          body: "http://localhost/runs/run-1",
          draft: true,
          targetBranch: "main",
        },
      },
    ]);
    expect(feedbackSuccess).toHaveBeenCalledTimes(1);
    expect(byTestId("git-panel-pr-reused")).toBeNull();
  });

  it("keeps a typed PR title across a git-state refresh tick", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    states = [published()];
    const view = render();

    await settle();
    await type(must<HTMLInputElement>("git-panel-pr-title"), "half typed");

    view.rerender({ refreshTick: 1 });
    await act(async () => {
      vi.advanceTimersByTime(1_000);
    });
    await settle();

    expect(gets()).toHaveLength(2);
    expect(must<HTMLInputElement>("git-panel-pr-title").value).toBe(
      "half typed",
    );
  });

  it("says so when an open PR already existed and nothing was applied", async () => {
    states = [published()];
    mutation = () => json({ ...OPENED, reused: true, draft: false });
    render();
    await settle();

    await click(must("git-panel-action-openPr"));

    expect(must("git-panel-pr-reused").textContent).toBe(
      "workbenchGit.pr.reused",
    );
  });

  it("disables Finalize on a closed PR, naming why", async () => {
    states = [
      published({
        pr: { url: PR_URL, number: 42, state: "closed", hasConflicts: null },
        actions: ALL_IDS.map((id) =>
          id === "finalizePr"
            ? { id, enabled: false, disabledReason: "pr-closed" }
            : { id, enabled: id === "openPr", disabledReason: null },
        ),
      }),
    ];
    render();
    await settle();

    const finalize = must<HTMLButtonElement>("git-panel-action-finalizePr");

    expect(finalize.disabled).toBe(true);
    expect(finalize.title).toBe("workbenchGit.disabledReason.pr-closed");
  });

  // D12: outside Review nothing asserts readiness, so the click is confirmed
  // through the shared destructive confirmation before anything is sent.
  it("finalizes outside Review only after a confirmation, with no Review-only field", async () => {
    states = [
      published({
        pr: { url: PR_URL, number: 42, state: "open", hasConflicts: null },
        actions: actions(["openPr", "finalizePr"]),
      }),
    ];
    render();
    await settle();

    await click(must("git-panel-action-finalizePr"));

    expect(must("git-panel-pr-finalize-dialog")).toBeTruthy();
    expect(posts()).toHaveLength(0);

    await click(must("git-panel-pr-finalize-confirm"));

    expect(posts()).toEqual([
      { url: `/api/runs/${RUN}/pr/finalize`, method: "POST", body: {} },
    ]);
    expect(byTestId("git-panel-pr-finalize-dialog")).toBeNull();
  });

  it("from Review sends the rendered target head, and offers Finalize anyway on drift", async () => {
    states = [
      published({
        runStatus: "Review",
        pr: { url: PR_URL, number: 42, state: "open", hasConflicts: null },
        actions: actions(["openPr", "finalizePr"]),
      }),
    ];
    let finalizeCalls = 0;

    mutation = () => {
      finalizeCalls += 1;

      return finalizeCalls === 1
        ? json(
            {
              code: "PRECONDITION",
              message: "target advanced since review",
              details: { reason: "target_drift" },
            },
            409,
          )
        : json({ ok: true, mode: "pull_request", pullRequestUrl: PR_URL });
    };
    render();
    await settle();

    expect(byTestId("git-panel-pr-finalize-anyway")).toBeNull();
    await click(must("git-panel-action-finalizePr"));

    expect(must("git-panel-error").textContent).toBe(
      "workbenchGit.errors.target_drift",
    );
    await click(must("git-panel-pr-finalize-anyway"));

    expect(posts().map((c) => c.body)).toEqual([
      { reviewedTargetCommit: "b".repeat(40) },
      { reviewedTargetCommit: "b".repeat(40), allowTargetDrift: true },
    ]);
    expect(byTestId("git-panel-pr-finalize-anyway")).toBeNull();
  });

  // D13: the server refuses any other target (`target_locked`), so the panel
  // never offers an edit it would refuse.
  it("shows a scratch run's PR target read-only, locked to its branch", async () => {
    states = [
      published({
        runKind: "scratch",
        prDefaults: {
          title: "Scratch",
          body: "http://localhost/runs/run-1",
          targetBranch: "release",
        },
      }),
    ];
    render();
    await settle();

    const target = must<HTMLInputElement>("git-panel-pr-target");

    expect(target.value).toBe("release");
    expect(target.readOnly).toBe(true);
    expect(must("git-panel-pr-target-locked").textContent).toBe(
      "workbenchGit.pr.targetLocked",
    );
  });

  it("keeps a flow run's PR target editable, with no lock note", async () => {
    states = [published()];
    render();
    await settle();

    expect(must<HTMLInputElement>("git-panel-pr-target").readOnly).toBe(false);
    expect(byTestId("git-panel-pr-target-locked")).toBeNull();
  });

  it("marks a scratch run's PR as not tracked (the scan skips scratch)", async () => {
    states = [
      published({
        runKind: "scratch",
        pr: { url: PR_URL, number: 42, state: "open", hasConflicts: null },
      }),
    ];
    render();
    await settle();

    expect(must("git-panel-pr-chip").textContent).toContain(
      "workbenchGit.prState.notTracked",
    );
  });
});
