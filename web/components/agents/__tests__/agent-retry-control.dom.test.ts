// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

import { AgentRetryControl } from "@/components/agents/agent-retry-control";
import { AgentRetryBatchControl } from "@/components/agents/agent-retry-batch-control";
import {
  AgentsAttachPanel,
  type AttachedAgentRow,
} from "@/components/board/panels/agents-attach-panel";

const options = {
  eligible: true,
  reason: null,
  expiresAt: "2026-11-02T12:05:00Z",
  previewFingerprint: "a".repeat(64),
  sourceRunnerId: "old",
  selectedRunnerId: "current",
  strategy: "pre_work_retry",
  qualificationOptIn: false,
  existingIntentId: null,
  runners: [
    { id: "alphabetical", label: "First runner", ready: true, reason: null },
    { id: "current", label: "Current runner", ready: true, reason: null },
  ],
  differences: [],
};
let root: Root;

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function click(label: string): Promise<void> {
  const element = [...document.querySelectorAll("button")].find(
    (item) => item.textContent === label,
  );

  if (!element) throw new Error(`Missing button ${label}`);
  await act(async () => element.click());
}

function render(): void {
  const element = document.createElement("div");

  document.body.append(element);
  root = createRoot(element);
  act(() => root.render(createElement(AgentRetryControl, { runId: "source" })));
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

it("keeps the current runner visible with actionable refusal and announces an unchanged refresh", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      response({
        ...options,
        eligible: false,
        reason: "reconciliation_required",
      }),
    ),
  );
  render();
  await click("retry");

  expect(document.querySelector("select")?.value).toBe("current");
  expect(document.body.textContent).toContain("refusal.reconciliation");
  expect(
    [...document.querySelectorAll("button")].find(
      (item) => item.textContent === "confirmRetry",
    )?.disabled,
  ).toBe(true);
  await click("refresh");
  expect(document.body.textContent).toContain("previewRefreshed");
});

it("can prepare a fresh preview after a settled refusal without stale receipt hiding the runner", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === "POST"
        ? response({
            retryIntentId: "intent",
            sourceRunId: "source",
            runId: null,
            intentState: "refused",
            runStatus: null,
            queueReason: null,
            refusalReason: "retry_context_changed",
            cleanup: null,
          })
        : response(options),
    ),
  );
  render();
  await click("retry");
  await click("confirmRetry");
  expect(
    document.querySelector('[data-testid="agent-retry-receipt"]'),
  ).not.toBeNull();
  await click("prepareAnotherAttempt");
  expect(
    document.querySelector('[data-testid="agent-retry-receipt"]'),
  ).toBeNull();
  expect(document.querySelector("select")?.value).toBe("current");
});

it("replays an unknown acceptance with exactly the same request and runner", async () => {
  const bodies: string[] = [];

  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method !== "POST") return response(options);
      bodies.push(String(init.body));
      if (bodies.length === 1) throw new TypeError("Connection lost");

      return response({
        retryIntentId: "intent",
        sourceRunId: "source",
        runId: "child",
        intentState: "launched",
        runStatus: "Pending",
        queueReason: null,
        refusalReason: null,
        cleanup: null,
      });
    }),
  );
  render();
  await click("retry");
  await click("confirmRetry");
  expect(document.body.textContent).toContain("retryUnknown");
  await click("retrySameRequest");
  expect(bodies).toHaveLength(2);
  expect(bodies[1]).toBe(bodies[0]);
  expect(JSON.parse(bodies[0]).runnerId).toBe("current");
  expect(document.body.textContent).toContain("status.Pending");
});

it("offers a newly configured runner for the batch, explicitly qualifies legacy tasks and reports each accepted or refused item", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const preview = {
    items: [
      {
        runId: "a",
        taskId: "task-a",
        title: "Task A",
        options: {
          ...options,
          strategy: "fresh_qualification",
          qualificationOptIn: true,
        },
        reason: null,
      },
      { runId: "b", taskId: "task-b", title: "Task B", options, reason: null },
      {
        runId: "duplicate",
        taskId: "task-a",
        title: "Earlier task A failure",
        options: null,
        reason: "retry_duplicate_task",
      },
    ],
    runners: options.runners,
    selectedRunnerId: "current",
    totalFailed: 3,
    hasMore: false,
    nextCursor: null,
  };

  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method !== "POST") return response(preview);
      bodies.push(JSON.parse(String(init.body)));

      return response({
        items: [
          {
            runId: "a",
            state: "accepted",
            reason: null,
            receipt: {
              retryIntentId: "intent-a",
              sourceRunId: "a",
              runId: "child-a",
              intentState: "launched",
              runStatus: "Pending",
              queueReason: null,
              refusalReason: null,
              cleanup: null,
            },
          },
          {
            runId: "b",
            state: "refused",
            reason: "retry_task_busy",
            receipt: null,
          },
        ],
      });
    }),
  );
  const element = document.createElement("div");

  document.body.append(element);
  root = createRoot(element);
  await act(async () =>
    root.render(
      createElement(AgentRetryBatchControl, {
        slug: "project",
        agentId: "core:triager",
        initialRunnerId: "current",
        offerAfterRunnerChange: true,
      }),
    ),
  );
  expect(document.querySelector("select")?.value).toBe("current");
  expect(document.body.textContent).toContain("qualificationOptIn");
  expect(document.body.textContent).toContain("refusal.duplicateTask");
  expect(bodies).toHaveLength(0);
  await click("confirmBatchRetry");
  expect(bodies).toHaveLength(1);
  expect(bodies[0]).toMatchObject({
    runnerId: "current",
    items: [
      { runId: "a", strategy: "fresh_qualification" },
      { runId: "b", strategy: "pre_work_retry" },
    ],
  });
  expect(document.body.textContent).toContain("status.Pending");
  expect(document.body.textContent).toContain("refusal.taskBusy");
});

it("only offers failed work after successfully saving a changed enabled agent runner", async () => {
  const row: AttachedAgentRow = {
    linkId: "link",
    enabled: true,
    runnerOverrideId: "old",
    branchBase: null,
    executionPolicyOverride: null,
    config: null,
    canReadBrain: false,
    canWriteBrain: false,
    memoryEnabled: false,
    crossProjectReach: false,
    schedulesRevision: 0,
    schedules: [],
    agent: {
      id: "core:triager",
      name: "Triager",
      packageName: "core",
      workspace: "repo_read",
      mode: "session",
      triggers: ["manual"],
      riskTier: "read_only",
      enabled: true,
      quarantinedAt: null,
      flowRef: null,
      recommended: null,
      configSchema: null,
      effectiveMcps: [],
    },
  };
  const calls: Array<{ url: string; method: string }> = [];

  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? "GET" });

      return response(
        init?.method === "PATCH"
          ? {}
          : {
              items: [
                {
                  runId: "source",
                  taskId: "task",
                  title: "Task",
                  options,
                  reason: null,
                },
              ],
              runners: options.runners,
              selectedRunnerId: "current",
              totalFailed: 1,
              hasMore: false,
              nextCursor: null,
            },
      );
    }),
  );
  const element = document.createElement("div");

  document.body.append(element);
  root = createRoot(element);
  act(() =>
    root.render(
      createElement(AgentsAttachPanel, {
        slug: "project",
        canManage: true,
        attached: [row],
        available: [],
        runners: [
          { id: "old", label: "Old runner" },
          { id: "current", label: "Current runner" },
        ],
        eventKinds: [],
      }),
    ),
  );
  await click("edit");
  await click("save");
  expect(calls).toHaveLength(1);
  expect(
    document.querySelector('[data-testid="agent-retry-batch-dialog"]'),
  ).toBeNull();
  await click("edit");
  const label = [...document.querySelectorAll("label")].find((item) =>
    item.textContent?.includes("runnerOverride"),
  );
  const selector = label?.querySelector("select");

  if (!selector) throw new Error("Missing attachment runner selector");
  await act(async () => {
    selector.value = "current";
    selector.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await click("save");
  expect(calls.map((item) => item.method)).toEqual(["PATCH", "PATCH", "GET"]);
  expect(
    document.querySelector('[data-testid="agent-retry-batch-dialog"]'),
  ).not.toBeNull();
  expect(
    document
      .querySelector('[data-testid="agent-retry-batch-dialog"] select')
      ?.getAttribute("disabled"),
  ).toBeNull();
  expect(document.body.textContent).toContain("runnerChangedRetryOffer");
  expect(calls.some((item) => item.url.endsWith("/retry"))).toBe(false);
});

it("retains the whole keyed batch request after an unknown response", async () => {
  const bodies: string[] = [];

  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method !== "POST")
        return response({
          items: [
            {
              runId: "a",
              taskId: "task-a",
              title: "Task A",
              options,
              reason: null,
            },
            {
              runId: "b",
              taskId: "task-b",
              title: "Task B",
              options,
              reason: null,
            },
          ],
          runners: options.runners,
          selectedRunnerId: "current",
          totalFailed: 2,
          hasMore: false,
          nextCursor: null,
        });
      bodies.push(String(init.body));
      if (bodies.length === 1) throw new TypeError("Connection lost");

      return response({
        items: [
          { runId: "a", state: "accepted", reason: null, receipt: null },
          {
            runId: "b",
            state: "unknown",
            reason: "retry_admission_failed",
            receipt: null,
          },
        ],
      });
    }),
  );
  const element = document.createElement("div");

  document.body.append(element);
  root = createRoot(element);
  act(() =>
    root.render(
      createElement(AgentRetryBatchControl, {
        slug: "project",
        agentId: "core:triager",
      }),
    ),
  );
  await click("retryAllFailed");
  await click("confirmBatchRetry");
  expect(document.body.textContent).toContain("retryUnknown");
  await click("retrySameRequest");
  expect(bodies).toHaveLength(2);
  expect(bodies[1]).toBe(bodies[0]);
  expect(JSON.parse(bodies[0]).items).toHaveLength(2);
  expect(
    [...document.querySelectorAll("button")].some(
      (item) => item.textContent === "retrySameRequest",
    ),
  ).toBe(true);
});

it("reloads the full retry receipt after cleanup rearm instead of treating a cleanup acknowledgement as the receipt", async () => {
  let rearmed = false;
  const receipt = {
    retryIntentId: "intent",
    sourceRunId: "source",
    runId: null,
    intentState: "refused",
    runStatus: null,
    queueReason: null,
    refusalReason: "retry_context_changed",
    cleanup: {
      state: "exhausted",
      revision: 4,
      reason: "retry_cleanup_failed",
    },
  };

  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("retry-options"))
        return response({
          ...options,
          existingIntentId: "intent",
          eligible: false,
        });
      if (init?.method === "POST") {
        rearmed = true;

        return response({
          retryIntentId: "intent",
          dispositionRevision: 5,
          state: "armed",
        });
      }

      return response(
        rearmed
          ? {
              ...receipt,
              cleanup: { state: "armed", revision: 5, reason: null },
            }
          : receipt,
      );
    }),
  );
  render();
  await click("retry");
  await click("retryCleanupAction");
  expect(document.body.textContent).toContain("retryState.refused");
  expect(document.body.textContent).toContain("retryCleanup.armed");
  expect(document.body.textContent).not.toContain("retryState.undefined");
});

it.each([true, false])(
  "advances past one hundred retained failures with an eligible first window=%s",
  async (firstWindowEligible) => {
    const batches: string[][] = [];
    const cursors: string[] = [];
    let firstReads = 0;
    const page = (start: number, nextCursor: string | null) => ({
      items: Array.from({ length: 50 }, (_, index) => ({
        runId: `run-${start + index}`,
        taskId: `task-${start + index}`,
        title: `Task ${start + index}`,
        options:
          firstWindowEligible || start > 100
            ? options
            : {
                ...options,
                eligible: false,
                reason: "retry_successor_already_owned",
                existingIntentId: "owned-intent",
              },
        reason:
          firstWindowEligible || start > 100
            ? null
            : "retry_successor_already_owned",
      })),
      runners: options.runners,
      selectedRunnerId: "current",
      totalFailed: 150,
      hasMore: nextCursor !== null,
      nextCursor,
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === "POST") {
          const body = JSON.parse(String(init.body)) as {
            items: Array<{ runId: string }>;
          };

          batches.push(body.items.map((item) => item.runId));

          return response({
            items: body.items.map((item) => ({
              runId: item.runId,
              state: "accepted",
              reason: null,
              receipt: {
                retryIntentId: `intent-${item.runId}`,
                sourceRunId: item.runId,
                runId: null,
                intentState: "accepted",
                runStatus: null,
                queueReason: null,
                refusalReason: null,
                cleanup: null,
              },
            })),
          });
        }
        const cursor =
          new URL(url, "http://test").searchParams.get("cursor") ?? "first";

        cursors.push(cursor);
        if (cursor === "first") {
          firstReads++;
          const initial = page(1, "second");

          return response(
            firstReads === 1
              ? initial
              : {
                  ...initial,
                  items: [
                    {
                      runId: "new-failure",
                      taskId: "new-task",
                      title: "Newly failed work",
                      options,
                      reason: null,
                    },
                    ...initial.items.slice(0, 49),
                  ],
                },
          );
        }

        return response(
          cursor === "second" ? page(51, "third") : page(101, null),
        );
      }),
    );
    const element = document.createElement("div");

    document.body.append(element);
    root = createRoot(element);
    act(() =>
      root.render(
        createElement(AgentRetryBatchControl, {
          slug: "project",
          agentId: "core:triager",
        }),
      ),
    );
    await click("retryAllFailed");
    await click("previewMoreFailed");
    if (firstWindowEligible) {
      await click("confirmBatchRetry");
      expect(batches[0]).toHaveLength(100);
    } else {
      expect(
        [...document.querySelectorAll("button")].find(
          (item) => item.textContent === "confirmBatchRetry",
        )?.disabled,
      ).toBe(true);
      expect(batches).toHaveLength(0);
    }
    await click("nextFailedWindow");
    expect(document.body.textContent).toContain("Task 101");
    expect(document.body.textContent).not.toContain("Task 50");
    expect(document.querySelector("select")?.value).toBe("current");
    await click("confirmBatchRetry");
    expect(batches.at(-1)?.[0]).toBe("run-101");
    await click("latestFailedWork");
    expect(document.body.textContent).toContain("Newly failed work");
    expect(cursors).toEqual(["first", "second", "third", "first"]);
  },
);

it("refreshes a stale cleanup revision and creates a new key after a definitive conflict", async () => {
  const bodies: Array<{
    expectedDispositionRevision: number;
    requestKey: string;
  }> = [];
  let revision = 4;

  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("retry-options"))
        return response({
          ...options,
          existingIntentId: "intent",
          eligible: false,
        });
      if (init?.method === "POST") {
        bodies.push(JSON.parse(String(init.body)));
        revision = bodies.length === 1 ? 6 : 7;

        return response(
          bodies.length === 1
            ? { reason: "retry_cleanup_revision_stale" }
            : {
                retryIntentId: "intent",
                dispositionRevision: 7,
                state: "armed",
              },
          bodies.length === 1 ? 409 : 200,
        );
      }

      return response({
        retryIntentId: "intent",
        sourceRunId: "source",
        runId: null,
        intentState: "refused",
        runStatus: null,
        queueReason: null,
        refusalReason: "retry_context_changed",
        cleanup: {
          state: revision === 7 ? "armed" : "exhausted",
          revision,
          reason: null,
        },
      });
    }),
  );
  render();
  await click("retry");
  await click("retryCleanupAction");
  expect(document.body.textContent).toContain("cleanupConflict");
  await click("retryCleanupAction");
  expect(bodies[1].expectedDispositionRevision).toBe(6);
  expect(bodies[1].requestKey).not.toBe(bodies[0].requestKey);
  expect(document.body.textContent).toContain("retryCleanup.armed");
});

it("keeps an unknown old batch explicitly recoverable after history selection changes and retries a failed initial preview", async () => {
  let reads = 0;
  const bodies: string[] = [];

  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/retry")) {
        bodies.push(String(init?.body));
        throw new TypeError("Connection lost");
      }
      reads++;
      if (reads === 1) throw new TypeError("Preview unavailable");

      return response({
        items: [
          {
            runId: "old",
            taskId: "task",
            title: "Original task",
            options,
            reason: null,
          },
        ],
        runners: options.runners,
        selectedRunnerId: "current",
        totalFailed: 1,
        hasMore: false,
        nextCursor: null,
      });
    }),
  );
  const element = document.createElement("div");

  document.body.append(element);
  root = createRoot(element);
  const props = { slug: "project", agentId: "core:triager", runIds: ["old"] };

  act(() => root.render(createElement(AgentRetryBatchControl, props)));
  await click("retrySelected");
  await click("refresh");
  await click("confirmBatchRetry");
  const closeButton = document.querySelector<HTMLButtonElement>(
    '[data-testid="agent-retry-batch-dialog"] button[aria-label="close"]',
  );

  await act(async () => closeButton?.click());
  act(() =>
    root.render(
      createElement(AgentRetryBatchControl, { ...props, runIds: [] }),
    ),
  );
  await click("recoverPendingBatch");
  expect(document.body.textContent).toContain("pendingBatchHint");
  expect(document.body.textContent).toContain("Original task");
  await click("retrySameRequest");
  expect(bodies[1]).toBe(bodies[0]);
  expect(reads).toBe(2);
});

it("refreshes the displayed canonical task request when the runner changes and submits that exact decision", async () => {
  const bodies: string[] = [];
  const request = {
    taskId: "task",
    agentId: "agent",
    workspace: "none",
    relaunchOfRunId: "source",
    runnerId: "current",
    expectedTaskRevision: 7,
    expectedSettingsToken: "current-token",
  };
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      bodies.push(String(init.body));

      return response({
        retryIntentId: "intent",
        sourceRunId: "source",
        runId: null,
        intentState: "accepted",
        runStatus: null,
        queueReason: null,
        refusalReason: null,
        cleanup: null,
      });
    }
    const selected = url.includes("runnerId=alphabetical")
      ? "alphabetical"
      : "current";

    return response({
      ...options,
      selectedRunnerId: selected,
      launchRequest: {
        ...request,
        runnerId: selected,
        expectedSettingsToken: `${selected}-token`,
      },
      launchPreview: {
        title: "Retry current specification",
        prompt: "The exact reviewed task input",
      },
    });
  });

  vi.stubGlobal("fetch", fetcher);
  render();
  await click("retry");
  expect(
    document.querySelector('[data-testid="retry-task-preview"]')?.textContent,
  ).toContain("The exact reviewed task input");
  const select = document.querySelector("select")!;

  await act(async () => {
    select.value = "alphabetical";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(
    fetcher.mock.calls.some(([url]) => url.endsWith("?runnerId=alphabetical")),
  ).toBe(true);
  await click("confirmRetry");
  expect(JSON.parse(bodies[0])).toMatchObject({
    runnerId: "alphabetical",
    launchRequest: {
      ...request,
      runnerId: "alphabetical",
      expectedSettingsToken: "alphabetical-token",
    },
  });
});
