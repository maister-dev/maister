// @vitest-environment jsdom

import type { Root } from "react-dom/client";

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { TaskAgentActions } from "@/components/social/task-agent-actions";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("next-intl", () => ({
  useLocale: () => "en",
  useTranslations: (namespace: string) => (key: string) =>
    `${namespace}.${key}`,
}));
const labels = {
  runAgent: "Run agent",
  sendToTriage: "Send to triage",
  busy: "Working",
  errorGeneric: "Failed",
  agentPickerLabel: "Agent",
};
let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  sessionStorage.clear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "EventSource",
    class extends EventTarget {
      close(): void {}
    },
  );
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
  const button = [...container.querySelectorAll("button")].find(
    (element) => element.textContent?.trim() === label,
  );

  if (!button) throw new Error(`Missing agent action ${label}`);
  expect(button.disabled).toBe(false);
  await act(async () => button.click());
}

it.each(["agent", "flow"] as const)(
  "previews the actual %s target, then submits the displayed revision only on Launch",
  async (kind) => {
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.startsWith("/api/task-launch-intents/options?"))
        return Response.json({
          taskId: "task-1",
          taskRevision: 8,
          settingsToken: "agent-settings",
          qualification: {
            freshness: "unassessed",
            sourceFailure: {
              runId: "failed-qualifier",
              stage: null,
              causeCode: null,
              modelStarted: null,
            },
          },
          activeLaunch: null,
          target: {
            kind,
            agentId: "core:helper",
            workspace: kind === "agent" ? "none" : "worktree",
            flowId: kind === "agent" ? null : "flow-1",
            flowRefId: kind === "agent" ? null : "core:bugfix",
            targetBranch: "main",
            runnerIds: ["codex-sol"],
            sessions: [
              {
                sessionName: "default",
                runnerId: "codex-sol",
                model: "gpt-6.1-sol",
              },
            ],
            runners: [
              {
                id: "codex-sol",
                capabilityAgent: "codex",
                model: "gpt-6.1-sol",
              },
            ],
            autoPromote: true,
            deliveryPolicy: {
              strategy: "pull_request",
              push: "on_success",
              trigger: "auto_on_ready",
              targetBranch: "main",
            },
            executionPolicy: { preset: "supervised" },
          },
        });
      if (url === "/api/task-launch-intents")
        return Response.json(
          {
            schemaVersion: 1,
            intentId: "agent-intent",
            taskId: "task-1",
            state: "queued",
            stateVersion: 1,
            basis: "manual",
            acceptedAt: "2026-11-03T09:00:00.000Z",
            taskRevision: 8,
            inputRevision: 1,
            settingsDigest: "a".repeat(64),
            runId: null,
            reason: null,
            snapshot: {
              kind,
              agentId: kind === "agent" ? "core:helper" : null,
              workspace: kind === "agent" ? "none" : "worktree",
              flowId: kind === "agent" ? null : "flow-1",
              flowRevisionId: kind === "agent" ? null : "flow-revision-1",
              runnerIds: ["codex-sol"],
              targetBranch: "main",
              autoPromote: true,
              baseCommit: null,
              promotionMode: "pull_request",
            },
          },
          { status: 202 },
        );

      throw new Error(`Unexpected agent request ${url} ${init?.method}`);
    });

    vi.stubGlobal("fetch", fetcher);
    const agents = [
      {
        id: "core:helper",
        name: "Helper",
        flowRef: kind === "agent" ? null : "core:bugfix",
        kind: "code_delivery" as const,
        workspace: "none" as const,
      },
    ];

    await act(async () =>
      root.render(
        createElement(TaskAgentActions, {
          slug: "demo",
          taskId: "task-1",
          taskNumber: 1,
          showSendToTriage: false,
          agents,
          labels,
        }),
      ),
    );
    await click("Run agent");
    expect(fetcher.mock.calls).toHaveLength(1);
    expect(fetcher.mock.calls[0][0]).toBe(
      `/api/task-launch-intents/options?taskId=task-1&agentId=core%3Ahelper${kind === "agent" ? "&workspace=none" : ""}`,
    );
    expect(fetcher.mock.calls[0][1]?.method).not.toBe("POST");
    expect(container.textContent).toContain("gpt-6.1-sol");
    expect(container.textContent).toContain("8");
    expect(container.textContent).toContain("launch.admission.triageFailed");
    expect(
      container.querySelector('a[href="/runs/failed-qualifier"]')?.textContent,
    ).toBe("launch.admission.openFailure");
    expect(container.textContent).not.toContain(
      "launch.admission.beforeModelFailure",
    );
    await click("launch.createRun");
    const request = fetcher.mock.calls.find(
      ([url]) => url === "/api/task-launch-intents",
    );

    expect(request).toBeDefined();
    expect(JSON.parse(String(request?.[1]?.body))).toEqual({
      taskId: "task-1",
      agentId: "core:helper",
      ...(kind === "agent" ? { workspace: "none" } : {}),
      expectedTaskRevision: 8,
      expectedSettingsToken: "agent-settings",
    });
    expect(
      new Headers(request?.[1]?.headers).get("Idempotency-Key"),
    ).toBeTruthy();
    expect(container.textContent).toContain("launch.admission.manual");
  },
);
