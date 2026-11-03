// @vitest-environment jsdom

import type { Root } from "react-dom/client";
import type { TaskLaunchReceipt } from "@/lib/tasks/launch-types";

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { LaunchPopover } from "@/components/board/launch-popover";
import { TaskLaunchHoldControl } from "@/components/board/task-launch-hold-control";

const { router } = vi.hoisted(() => ({
  router: { refresh: vi.fn(), push: vi.fn() },
}));

vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("next-intl", () => ({
  useLocale: () => "en",
  useTranslations: (namespace: string) => (key: string) =>
    `${namespace}.${key}`,
}));

class AttentionSource extends EventTarget {
  static instances: AttentionSource[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) {
    super();
    AttentionSource.instances.push(this);
  }

  close(): void {}

  tick(): void {
    this.dispatchEvent(
      new MessageEvent("attention.tick", {
        data: JSON.stringify({ changed: ["work"], decisions: 0, updates: 0 }),
        lastEventId: "100",
      }),
    );
  }
}

const options = {
  launchability: { launchable: true, reason: "launchable", blockers: [] },
  relaunch: { launchable: true, reason: "launchable" },
  settingsToken: "settings-token-1",
  activeLaunch: null,
  qualification: {
    required: true,
    mode: "required",
    freshness: "unassessed",
    decision: null,
    publicationState: null,
    blockedReason: "qualification_required",
  },
  flows: [{ id: "flow-1", refId: "flow-ref-1", name: "Bugfix", enabled: true }],
  runners: [],
  selectedFlowId: "flow-1",
  selectedRunnerId: null,
  branches: ["main"],
  defaultBaseBranch: "main",
  defaultTargetBranch: "main",
  deliveryPolicyDefault: {
    strategy: "pull_request",
    push: "on_success",
    trigger: "auto_on_ready",
    targetBranch: "main",
  },
  executionPolicyDefault: { preset: "supervised" },
  availablePackageVersions: [],
  task: { projectSlug: "demo", number: 27, flowId: null, revision: 3 },
};

const receipt: TaskLaunchReceipt = {
  schemaVersion: 1,
  intentId: "intent-1",
  taskId: "task-1",
  state: "queued",
  stateVersion: 1,
  basis: "manual",
  acceptedAt: "2026-11-03T09:00:00.000Z",
  taskRevision: 3,
  inputRevision: 2,
  settingsDigest: "a".repeat(64),
  runId: null,
  reason: null,
  queueReason: "capacity",
  snapshot: {
    kind: "flow",
    workspace: "worktree",
    flowId: "flow-1",
    flowRevisionId: "revision-1",
    agentId: null,
    runnerIds: ["codex-sol"],
    baseCommit: "b".repeat(40),
    targetBranch: "main",
    promotionMode: "pull_request",
    autoPromote: true,
  },
};

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  AttentionSource.instances = [];
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("EventSource", AttentionSource);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function click(label: string): Promise<void> {
  const target = [...document.querySelectorAll("button")].find(
    (button) => button.textContent?.trim() === label,
  );

  if (!target) throw new Error(`Launch interaction button missing: ${label}`);
  expect(target.disabled).toBe(false);
  await act(async () => {
    target.focus();
    target.click();
  });
}

async function open(forceRelaunch = false): Promise<void> {
  await act(async () =>
    root.render(
      createElement(LaunchPopover, {
        taskId: "task-1",
        label: "Launch",
        disabledLabel: "Unavailable",
        forceRelaunch,
      }),
    ),
  );
  await click("Launch");
}

it("launches a flowless unassessed task in one intent request without first editing the Flow", async () => {
  const fetcher = vi.fn(async (url: string, _init?: RequestInit) => {
    if (url.startsWith("/api/runs/launch-options?"))
      return Response.json(options);
    if (url === "/api/task-launch-intents")
      return Response.json(receipt, { status: 202 });

    throw new Error(`Unexpected request ${url}`);
  });

  vi.stubGlobal("fetch", fetcher);
  await open();
  await click("launch.createRun");
  const post = fetcher.mock.calls.find(
    ([url]) => url === "/api/task-launch-intents",
  );

  expect(post).toBeDefined();
  expect(fetcher.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(
    false,
  );
  expect(JSON.parse(String(post![1]?.body))).toMatchObject({
    taskId: "task-1",
    flowId: "flow-1",
    expectedTaskRevision: 3,
    expectedSettingsToken: "settings-token-1",
    deliveryPolicy: { strategy: "pull_request", trigger: "auto_on_ready" },
  });
  expect(new Headers(post![1]?.headers).get("Idempotency-Key")).toBeTruthy();
  expect(document.body.textContent).toContain("launch.admission.manual");
  expect(document.body.textContent).toContain("launch.admission.waiting");
  expect(document.body.textContent).not.toContain(
    "taskQualification.manualTitle",
  );
});

it.each([
  ["manual", "launch.triggerManual"],
  ["auto_on_ready", "launch.triggerAutoOnReady"],
] as const)(
  "shows the accepted %s delivery trigger when automatic promotion is permitted",
  async (trigger, label) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.startsWith("/api/runs/launch-options?"))
          return Response.json(options);
        if (url === "/api/task-launch-intents")
          return Response.json(
            {
              ...receipt,
              snapshot: {
                ...receipt.snapshot,
                autoPromote: true,
                deliveryPolicy: {
                  ...options.deliveryPolicyDefault,
                  trigger,
                },
              },
            },
            { status: 202 },
          );

        throw new Error(`Unexpected request ${url}`);
      }),
    );
    await open();
    await click("launch.createRun");
    const status = document.querySelector(
      '[data-testid="task-launch-intent-status"]',
    );
    const promotion = [...(status?.querySelectorAll("dt") ?? [])].find(
      (field) => field.textContent === "launch.admission.promotion",
    );

    expect(promotion?.nextElementSibling?.textContent).toBe(label);
  },
);

it("explains a pre-model Triager infrastructure failure without blocking manual launch", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({
        ...options,
        qualification: {
          ...options.qualification,
          sourceFailure: {
            runId: "triager-failed",
            stage: "baseline",
            causeCode: "ENOENT",
            modelStarted: false,
          },
        },
      }),
    ),
  );
  await open();
  expect(document.body.textContent).toContain("launch.admission.triageFailed");
  expect(document.body.textContent).toContain(
    "launch.admission.beforeModelFailure",
  );
  expect(
    document.querySelector('a[href="/runs/triager-failed"]'),
  ).not.toBeNull();
  const launch = [...document.querySelectorAll("button")].find(
    (button) => button.textContent === "launch.createRun",
  );

  expect(launch?.disabled).toBe(false);
});

it("retries an uncertain response with the exact same request key and body across closing the dialog", async () => {
  let attempts = 0;
  const fetcher = vi.fn(async (url: string, _init?: RequestInit) => {
    if (url.startsWith("/api/runs/launch-options?"))
      return Response.json(options);
    if (url === "/api/task-launch-intents") {
      attempts += 1;
      if (attempts === 1) throw new TypeError("response lost");

      return Response.json(receipt, { status: 202 });
    }

    throw new Error(`Unexpected request ${url}`);
  });

  vi.stubGlobal("fetch", fetcher);
  await open();
  await click("launch.createRun");
  expect(document.body.textContent).toContain("launch.admission.uncertain");
  const closeButton = document.querySelector<HTMLButtonElement>(
    'button[aria-label="launch.close"]',
  );

  if (!closeButton) throw new Error("Close button is missing");
  await act(async () => closeButton.click());
  await act(async () => root.unmount());
  root = createRoot(container);
  await open();
  await click("launch.admission.retryRequest");
  const posts = fetcher.mock.calls.filter(
    ([url]) => url === "/api/task-launch-intents",
  );

  expect(posts).toHaveLength(2);
  expect(posts[1][1]?.body).toBe(posts[0][1]?.body);
  expect(new Headers(posts[1][1]?.headers).get("Idempotency-Key")).toBe(
    new Headers(posts[0][1]?.headers).get("Idempotency-Key"),
  );
  expect(document.body.textContent).toContain("launch.admission.waiting");
});

it("refreshes an accepted request on an attention tick and shows a changed queued request as held", async () => {
  const fetcher = vi.fn(async (url: string, _init?: RequestInit) => {
    if (url.startsWith("/api/runs/launch-options?"))
      return Response.json(options);
    if (url === "/api/task-launch-intents")
      return Response.json(receipt, { status: 202 });
    if (url === "/api/task-launch-intents/intent-1")
      return Response.json({
        ...receipt,
        state: "held",
        stateVersion: 2,
        reason: "launch_input_changed",
      });

    throw new Error(`Unexpected request ${url}`);
  });

  vi.stubGlobal("fetch", fetcher);
  await open();
  await click("launch.createRun");
  const source = AttentionSource.instances[0];

  expect(source).toBeDefined();
  await act(async () => source.tick());
  expect(document.body.textContent).toContain("launch.admission.held");
  expect(document.body.textContent).toContain("launch.admission.replace");
  expect(router.push).not.toHaveBeenCalled();
});

it("uses the dedicated intentional concurrent launch operation rather than a bypass flag", async () => {
  const fetcher = vi.fn(async (url: string, _init?: RequestInit) => {
    if (url.startsWith("/api/runs/launch-options?"))
      return Response.json({
        ...options,
        activeLaunch: { ...receipt, intentId: "ordinary-request" },
        task: { ...options.task, flowId: "flow-1" },
      });
    if (url === "/api/task-launch-intents/concurrent")
      return Response.json(receipt, { status: 202 });

    throw new Error(`Unexpected request ${url}`);
  });

  vi.stubGlobal("fetch", fetcher);
  await open(true);
  await click("launch.createRun");
  const post = fetcher.mock.calls.find(
    ([url]) => url === "/api/task-launch-intents/concurrent",
  );

  expect(post).toBeDefined();
  expect(JSON.parse(String(post![1]?.body))).not.toHaveProperty(
    "allowConcurrent",
  );
});

it("cancels a queued request using its observed state version without creating another launch", async () => {
  const fetcher = vi.fn(async (url: string, _init?: RequestInit) => {
    if (url.startsWith("/api/runs/launch-options?"))
      return Response.json(options);
    if (url === "/api/task-launch-intents")
      return Response.json(receipt, { status: 202 });
    if (url === "/api/task-launch-intents/intent-1/cancel")
      return Response.json({ ...receipt, state: "cancelled", stateVersion: 2 });

    throw new Error(`Unexpected request ${url}`);
  });

  vi.stubGlobal("fetch", fetcher);
  await open();
  await click("launch.createRun");
  await click("launch.admission.cancel");
  const cancellation = fetcher.mock.calls.find(([url]) =>
    url.endsWith("/cancel"),
  );

  expect(JSON.parse(String(cancellation?.[1]?.body))).toEqual({
    expectedStateVersion: 1,
  });
  expect(document.body.textContent).toContain("launch.admission.cancelled");
  expect(
    fetcher.mock.calls.filter(([url]) => url === "/api/task-launch-intents"),
  ).toHaveLength(1);
});

it("requires a new explicit launch when replacing a held request and sends both current revisions", async () => {
  let previewCount = 0;
  const held = {
    ...receipt,
    state: "held",
    stateVersion: 2,
    reason: "launch_input_changed",
  };
  const fetcher = vi.fn(async (url: string, _init?: RequestInit) => {
    if (url.startsWith("/api/runs/launch-options?")) {
      previewCount += 1;

      return Response.json({
        ...options,
        task: { ...options.task, revision: previewCount === 1 ? 3 : 4 },
      });
    }
    if (url === "/api/task-launch-intents")
      return Response.json(held, { status: 202 });
    if (url === "/api/task-launch-intents/intent-1/replace")
      return Response.json(
        { ...receipt, intentId: "intent-2", taskRevision: 4 },
        { status: 202 },
      );

    throw new Error(`Unexpected request ${url}`);
  });

  vi.stubGlobal("fetch", fetcher);
  await open();
  await click("launch.createRun");
  await click("launch.admission.replace");
  expect(
    document
      .querySelector('[data-testid="task-launch-dialog"]')
      ?.contains(document.activeElement),
  ).toBe(true);
  expect(
    fetcher.mock.calls.filter(([url]) => url.endsWith("/replace")),
  ).toHaveLength(0);
  await click("launch.createRun");
  const replacement = fetcher.mock.calls.find(([url]) =>
    url.endsWith("/replace"),
  );

  expect(JSON.parse(String(replacement?.[1]?.body))).toMatchObject({
    expectedStateVersion: 2,
    expectedTaskRevision: 4,
  });
  expect(document.body.textContent).toContain("launch.admission.manual");
});

it("resolves a separate historical hold only after review and never launches as a side effect", async () => {
  const fetcher = vi.fn(async (_url: string, _init?: RequestInit) =>
    Response.json({
      taskId: "task-1",
      revision: 8,
      triageStatus: null,
      triageFlagOrigin: null,
    }),
  );

  vi.stubGlobal("fetch", fetcher);
  await act(async () =>
    root.render(
      createElement(TaskLaunchHoldControl, {
        taskId: "task-1",
        revision: 7,
        origin: "unknown",
        canAct: true,
      }),
    ),
  );
  await click("launch.admission.resolveHold");
  expect(fetcher).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain(
    "launch.admission.holdOrigin.unknown",
  );
  await click("launch.admission.confirmResolveHold");
  expect(fetcher.mock.calls[0][0]).toBe("/api/task-launch-holds/resolve");
  expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({
    taskId: "task-1",
    expectedRevision: 7,
    expectedOrigin: "unknown",
  });
  expect(router.refresh).toHaveBeenCalledOnce();
  expect(router.push).not.toHaveBeenCalled();
});

it.each(["automatic", "manual"] as const)(
  "shows earlier %s work while clearly rejecting the losing request",
  async (basis) => {
    let previews = 0;
    const fetcher = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url.startsWith("/api/runs/launch-options?")) {
        previews += 1;

        return Response.json({
          ...options,
          activeLaunch:
            previews === 1
              ? null
              : {
                  ...receipt,
                  intentId: "earlier-1",
                  runId: "earlier-run",
                  basis,
                },
        });
      }
      if (url === "/api/task-launch-intents")
        return Response.json(
          {
            code: "CONFLICT",
            details: {
              reason: "launch_already_reserved",
              existing: { intentId: "earlier-1", runId: "earlier-run", basis },
            },
          },
          { status: 409 },
        );

      throw new Error(`Unexpected request ${url}`);
    });

    vi.stubGlobal("fetch", fetcher);
    await open();
    await click("launch.createRun");
    expect(document.body.textContent).toContain(
      "launch.admission.conflictNotAccepted",
    );
    expect(document.body.textContent).toContain(
      `launch.admission.existingBasis.${basis}`,
    );
    expect(
      document.querySelector('a[href="/runs/earlier-run"]'),
    ).not.toBeNull();
    const posts = fetcher.mock.calls.filter(
      ([url]) => url === "/api/task-launch-intents",
    );

    expect(posts).toHaveLength(1);
    expect(JSON.parse(String(posts[0][1]?.body))).toMatchObject({
      expectedTaskRevision: 3,
      flowId: "flow-1",
      expectedSettingsToken: "settings-token-1",
    });
    expect(previews).toBe(2);
  },
);

it.each(["receipt", "error"] as const)(
  "fences a late predecessor status %s after replacement, including stored recovery",
  async (outcome) => {
    const oldStatus = Promise.withResolvers<Response>();
    const held = {
      ...receipt,
      state: "held",
      stateVersion: 2,
      reason: "launch_input_changed",
    };
    const successor = {
      ...receipt,
      intentId: "intent-2",
      taskRevision: 4,
      state: "run_bound",
      stateVersion: 3,
      runId: "run-2",
      runStatus: "Pending",
    };
    const fetcher = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url.startsWith("/api/runs/launch-options?"))
        return Response.json({
          ...options,
          task: { ...options.task, revision: 4 },
        });
      if (url === "/api/task-launch-intents")
        return Response.json(held, { status: 202 });
      if (url === "/api/task-launch-intents/intent-1") return oldStatus.promise;
      if (url === "/api/task-launch-intents/intent-1/replace")
        return Response.json(successor, { status: 202 });

      throw new Error(`Unexpected request ${url}`);
    });

    vi.stubGlobal("fetch", fetcher);
    await open();
    await click("launch.createRun");
    await click("launch.admission.refresh");
    await click("launch.admission.replace");
    await click("launch.createRun");
    expect(document.querySelector('a[href="/runs/run-2"]')).not.toBeNull();
    await act(async () =>
      oldStatus.resolve(
        outcome === "receipt"
          ? Response.json({ ...held, state: "cancelled", stateVersion: 3 })
          : Response.json(
              { code: "PRECONDITION", details: { reason: "launch_not_found" } },
              { status: 404 },
            ),
      ),
    );
    await act(async () => root.unmount());
    root = createRoot(container);
    await open();
    expect(document.querySelector('a[href="/runs/run-2"]')).not.toBeNull();
    expect(document.body.textContent).not.toContain(
      "launch.admission.cancelled",
    );
    expect(document.body.textContent).not.toContain(
      "launch.admission.reason.technical",
    );
    expect(
      fetcher.mock.calls.filter(([url]) => url.endsWith("/replace")),
    ).toHaveLength(1);
  },
);

it("does not let an unmounted request overwrite a successful same-key recovery", async () => {
  const first = Promise.withResolvers<Response>();
  let attempts = 0;
  const fetcher = vi.fn(async (url: string, _init?: RequestInit) => {
    if (url.startsWith("/api/runs/launch-options?"))
      return Response.json(options);
    if (url === "/api/task-launch-intents") {
      attempts += 1;

      return attempts === 1
        ? first.promise
        : Response.json(receipt, { status: 202 });
    }

    throw new Error(`Unexpected request ${url}`);
  });

  vi.stubGlobal("fetch", fetcher);
  await open();
  await click("launch.createRun");
  await act(async () => root.unmount());
  root = createRoot(container);
  await open();
  await click("launch.admission.retryRequest");
  await act(async () => first.reject(new TypeError("old connection failed")));
  await act(async () => root.unmount());
  root = createRoot(container);
  await open();
  expect(document.body.textContent).toContain("launch.admission.waiting");
  expect(document.body.textContent).not.toContain("launch.admission.uncertain");
  const posts = fetcher.mock.calls.filter(
    ([url]) => url === "/api/task-launch-intents",
  );

  expect(posts).toHaveLength(2);
  expect(posts[0][1]?.body).toBe(posts[1][1]?.body);
  expect(new Headers(posts[0][1]?.headers).get("Idempotency-Key")).toBe(
    new Headers(posts[1][1]?.headers).get("Idempotency-Key"),
  );
});

it("wraps Tab and Shift+Tab inside the launch dialog and restores the opener on Escape", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json(options)),
  );
  await open();
  const dialog = document.querySelector<HTMLElement>(
    '[data-testid="task-launch-dialog"]',
  );

  if (!dialog) throw new Error("Launch dialog is missing");
  const controls = [
    ...dialog.querySelectorAll<HTMLElement>(
      'button:not([disabled]),select:not([disabled]),input:not([disabled]),a[href],[tabindex]:not([tabindex="-1"])',
    ),
  ];
  const first = controls[0];
  const last = controls[controls.length - 1];

  last.focus();
  await act(async () =>
    document.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Tab",
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
  expect(document.activeElement).toBe(first);
  await act(async () =>
    document.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Tab",
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
  expect(document.activeElement).toBe(last);
  await act(async () =>
    document.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.activeElement?.textContent).toBe("Launch");
});
