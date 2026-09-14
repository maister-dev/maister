// @vitest-environment jsdom

import type { Root } from "react-dom/client";

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LaunchPopover } from "@/components/board/launch-popover";
import {
  formatLaunchErrorFrame,
  formatLaunchResultFrame,
} from "@/lib/runs/launch-progress";

const { router } = vi.hoisted(() => ({
  router: { refresh: vi.fn(), push: vi.fn() },
}));

vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("next-intl", () => ({
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
  task: { projectSlug: "course", number: 1 },
};

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.clearAllMocks();
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

function serveLaunchFrame(frame: string): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.startsWith("/api/runs/launch-options?")) {
        return Response.json(launchOptions);
      }
      if (url === "/api/runs") {
        return new Response(frame, {
          headers: { "content-type": "text/event-stream" },
        });
      }

      throw new Error(`Unexpected launch request: ${url}`);
    }),
  );
}

describe("launch destination", () => {
  it.each(["Running", "NeedsInput", "Pending"])(
    "opens the new run after a successful %s launch",
    async (status) => {
      serveLaunchFrame(formatLaunchResultFrame({ runId: "run-1", status }));
      await clickButton("Launch");
      expect(document.querySelector('[role="dialog"]')).not.toBeNull();
      await clickButton("launch.createRun");

      expect(router.push).toHaveBeenCalledOnce();
      expect(router.push).toHaveBeenCalledWith("/runs/run-1");
      expect(router.refresh).not.toHaveBeenCalled();
      expect(document.querySelector('[role="dialog"]')).toBeNull();
    },
  );

  it("keeps the launch form open when the launch stream reports failure", async () => {
    serveLaunchFrame(formatLaunchErrorFrame("PRECONDITION", "Cannot launch"));
    await clickButton("Launch");
    await clickButton("launch.createRun");

    expect(router.push).not.toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(document.querySelector('[role="alert"]')).not.toBeNull();
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
