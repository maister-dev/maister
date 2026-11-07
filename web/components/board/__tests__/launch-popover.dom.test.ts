// @vitest-environment jsdom

import type { Root } from "react-dom/client";

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LaunchPopover } from "@/components/board/launch-popover";

const { router } = vi.hoisted(() => ({
  router: { refresh: vi.fn(), push: vi.fn() },
}));

vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("next-intl", () => ({
  useLocale: () => "en",
  useTranslations: (namespace: string) => (key: string) =>
    `${namespace}.${key}`,
}));

const launchOptions = {
  launchability: { launchable: true, reason: "ready", blockers: [] },
  flows: [
    {
      id: "flow-1",
      refId: "flow-ref-1",
      name: "Questionnaire",
      version: "1.0.0",
      enabled: true,
      isTaskDefault: true,
    },
  ],
  runners: [],
  selectedFlowId: "flow-1",
  selectedRunnerId: null,
  branches: ["main"],
  defaultBaseBranch: "main",
  defaultTargetBranch: "main",
  deliveryPolicyDefault: {
    strategy: "merge",
    push: "never",
    trigger: "manual",
    targetBranch: "main",
  },
  executionPolicyDefault: { preset: "supervised" },
  availablePackageVersions: [],
  task: { projectSlug: "course", number: 1, revision: 2 },
  settingsToken: "settings-token",
  qualification: null,
  activeLaunch: null,
};

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  vi.stubGlobal(
    "EventSource",
    class extends EventTarget {
      onopen = null;
      onerror = null;
      close(): void {}
    },
  );
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() =>
    root.render(
      createElement(LaunchPopover, {
        taskId: "task-1",
        label: "Launch",
        disabledLabel: "Unavailable",
      }),
    ),
  );
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function clickButton(label: string): Promise<void> {
  const button = Array.from(document.querySelectorAll("button")).find(
    (candidate) => candidate.textContent === label,
  );

  if (!button) throw new Error(`Launch button missing: ${label}`);
  expect(button.disabled).toBe(false);
  await act(async () => button.click());
}

function serveLaunchResponse(payload: object, status = 202): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.startsWith("/api/runs/launch-options?")) {
        return Response.json(launchOptions);
      }
      if (url === "/api/task-launch-intents")
        return Response.json(payload, { status });

      throw new Error(`Unexpected launch request: ${url}`);
    }),
  );
}

describe("launch destination", () => {
  it.each(["Running", "NeedsInput", "Pending"])(
    "keeps an accepted %s launch visible with the correct run destination",
    async (status) => {
      serveLaunchResponse({
        schemaVersion: 1,
        intentId: "intent-1",
        taskId: "task-1",
        state: "run_bound",
        stateVersion: 3,
        basis: "manual",
        acceptedAt: "2026-11-03T09:00:00.000Z",
        taskRevision: 2,
        inputRevision: 1,
        settingsDigest: "a".repeat(64),
        runId: "run-1",
        reason: null,
        runStatus: status,
        snapshot: {
          kind: "flow",
          workspace: "worktree",
          flowId: "flow-1",
          flowRevisionId: "revision-1",
          agentId: null,
          runnerIds: ["codex-sol"],
          baseCommit: "b".repeat(40),
          targetBranch: "main",
          promotionMode: "local_merge",
          autoPromote: false,
        },
      });
      await clickButton("Launch");
      expect(document.querySelector('[role="dialog"]')).not.toBeNull();
      await clickButton("launch.createRun");

      expect(document.querySelector('a[href="/runs/run-1"]')).not.toBeNull();
      expect(router.push).not.toHaveBeenCalled();
      expect(router.refresh).not.toHaveBeenCalled();
      expect(
        document.querySelector('[data-testid="task-launch-intent-status"]'),
      ).not.toBeNull();
    },
  );

  it("keeps the launch form open for a definitive admission refusal", async () => {
    serveLaunchResponse(
      { code: "PRECONDITION", details: { reason: "launch_settings_changed" } },
      409,
    );
    await clickButton("Launch");
    await clickButton("launch.createRun");

    expect(router.push).not.toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "launch.admission.reason.settingsChanged",
    );
  });

  it("localizes an actionable typed refusal without exposing backend messages", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.startsWith("/api/runs/launch-options?")) {
          return Response.json(launchOptions);
        }
        if (url === "/api/task-launch-intents") {
          return Response.json(
            {
              code: "PRECONDITION",
              message: "private backend details",
              details: { reason: "launch_input_changed" },
            },
            { status: 409 },
          );
        }

        throw new Error(`Unexpected launch request: ${url}`);
      }),
    );
    await clickButton("Launch");
    await clickButton("launch.createRun");

    expect(router.push).not.toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "launch.admission.reason.inputChanged",
    );
    expect(document.body.textContent).not.toContain("private backend details");
  });

  it("refreshes the current page without navigating when scheduling a future run", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.startsWith("/api/runs/launch-options?")) {
          return Response.json(launchOptions);
        }
        if (url === "/api/projects/course/scheduled-launches") {
          return Response.json({ id: "scheduled-1" });
        }

        throw new Error(`Unexpected schedule request: ${url}`);
      }),
    );
    await clickButton("Launch");
    await clickButton("launch.scheduleRun");

    const scheduledTime = document.querySelector<HTMLInputElement>(
      'input[type="datetime-local"]',
    );
    const setValue = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set;

    if (!scheduledTime || !setValue)
      throw new Error("Schedule time input missing");

    act(() => {
      setValue.call(scheduledTime, "2030-01-01T12:00");
      scheduledTime.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await clickButton("launch.confirmSchedule");

    expect(router.refresh).toHaveBeenCalledOnce();
    expect(router.push).not.toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
});
