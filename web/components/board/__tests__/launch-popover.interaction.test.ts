// @vitest-environment jsdom

import type { ReactNode } from "react";
import type { Root } from "react-dom/client";

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), refresh: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mocks.refresh }),
}));
vi.mock("next-intl", () => ({
  useLocale: () => "en",
  useTranslations:
    (namespace: string) => (key: string, values?: Record<string, string>) =>
      `${namespace}.${key}${values?.role ? ` ${values.role}` : ""}${values?.runner ? ` ${values.runner}` : ""}`,
}));

// Keep the real dialog, state, DOM events, requests and cancellation. Replace
// only the design-system primitives so these tests do not depend on animation
// or layout APIs that jsdom cannot provide.
vi.mock("@heroui/react", async () => {
  const React = await import("react");

  type Choice = { id: string; children?: ReactNode; isDisabled?: boolean };

  function choices(children: ReactNode): Choice[] {
    return React.Children.toArray(children).flatMap((child): Choice[] => {
      if (!React.isValidElement<Partial<Choice>>(child)) return [];
      if (typeof child.props.id === "string")
        return [{ ...child.props, id: child.props.id }];

      return choices(child.props.children);
    });
  }

  const Pass = ({ children }: { children?: ReactNode }) => children;
  const Select = Object.assign(
    (props: {
      children: ReactNode;
      selectedKey: string;
      isDisabled?: boolean;
      onSelectionChange: (key: string) => void;
      "aria-labelledby"?: string;
    }) =>
      React.createElement(
        "select",
        {
          "aria-labelledby": props["aria-labelledby"],
          value: props.selectedKey,
          disabled: props.isDisabled,
          onChange: (event: React.ChangeEvent<HTMLSelectElement>) =>
            props.onSelectionChange(event.target.value),
        },
        choices(props.children).map((choice) =>
          React.createElement(
            "option",
            { key: choice.id, value: choice.id, disabled: choice.isDisabled },
            choice.children,
          ),
        ),
      ),
    { Trigger: Pass, Value: () => null, Indicator: () => null, Popover: Pass },
  );

  return {
    Select,
    ListBox: Object.assign(Pass, { Item: Pass }),
    Button: ({
      isDisabled,
      size: _size,
      variant: _variant,
      ...props
    }: React.ButtonHTMLAttributes<HTMLButtonElement> & {
      isDisabled?: boolean;
      size?: string;
      variant?: string;
    }) => React.createElement("button", { ...props, disabled: isDisabled }),
  };
});

import { LaunchPopover } from "@/components/board/launch-popover";

const SLOT_KEY = "consensus:plan_consensus:reviewer";
const ROLE = "plan_consensus · reviewer";

function preview(
  mappedRunnerId: string | null,
  canConfigureRunnerBindings = true,
) {
  return {
    launchability: {
      launchable: mappedRunnerId !== null,
      reason: mappedRunnerId ? "launchable" : "runner_unresolved",
      blockers: [],
    },
    relaunch: {
      launchable: mappedRunnerId !== null,
      reason: mappedRunnerId ? "launchable" : "runner_unresolved",
    },
    flows: [{ id: "flow-1", name: "Planning", enabled: true }],
    runners: ["claude-platform", "codex-ready", "codex-other"].map((id) => ({
      id,
      label: id,
      adapter: id.startsWith("codex") ? "codex" : "claude",
      capabilityAgent: id.startsWith("codex") ? "codex" : "claude",
      model: "model",
      enabled: true,
      readinessStatus: "Ready",
      pinnedModel: { model: "model", source: "runner" },
    })),
    selectedFlowId: "flow-1",
    selectedFlowRevisionId: "revision-1",
    selectedRunnerId: "claude-platform",
    canConfigureRunnerBindings,
    consensusRunnerSlots: [
      {
        slotKey: SLOT_KEY,
        label: ROLE,
        kind: "consensus_participant",
        mappedRunnerId,
        runnerId: mappedRunnerId,
        errorCode: mappedRunnerId ? null : "CONFIG",
      },
    ],
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
    task: { projectSlug: "demo", number: 1, flowId: "flow-1", revision: 1 },
    settingsToken: "settings-token",
    qualification: null,
    activeLaunch: null,
  };
}

function deferredResponse(): {
  promise: Promise<Response>;
  resolve: (response: Response) => void;
} {
  let settle: ((response: Response) => void) | undefined;
  const promise = new Promise<Response>((resolve) => {
    settle = resolve;
  });

  return {
    promise,
    resolve: (response) => {
      if (!settle) throw new Error("deferred response was not initialized");
      settle(response);
    },
  };
}

function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll("button")].find(
    (item) =>
      item.getAttribute("aria-label") === label ||
      item.textContent?.trim() === label,
  );

  if (!found) throw new Error(`button not found: ${label}`);

  return found;
}

function roleSelect(): HTMLSelectElement {
  const found = document.querySelector<HTMLSelectElement>(
    "[data-testid=launch-runner-slots] label select",
  );

  if (!found) throw new Error("consensus runner select not found");

  return found;
}

function primarySelect(): HTMLSelectElement {
  const found = [
    ...document.querySelectorAll<HTMLSelectElement>("select[aria-labelledby]"),
  ].find(
    (item) =>
      document.getElementById(item.getAttribute("aria-labelledby") ?? "")
        ?.textContent === "launch.runnerModel",
  );

  if (!found) throw new Error("primary runner select not found");

  return found;
}

async function click(target: HTMLElement): Promise<void> {
  await act(async () => {
    target.click();
  });
}

async function choose(target: HTMLSelectElement, value: string): Promise<void> {
  await act(async () => {
    target.value = value;
    target.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.resetAllMocks();
  sessionStorage.clear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", mocks.fetch);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function openDialog(): Promise<void> {
  await act(async () => {
    root.render(
      createElement(LaunchPopover, {
        taskId: "task-1",
        label: "Open launch",
        disabledLabel: "Unavailable",
      }),
    );
  });
  await click(button("Open launch"));
}

describe("frozen execution policy", () => {
  const policy = {
    preset: "supervised",
    overrides: {
      budget: { run: { maxTokens: 1000 } },
      crashRetry: "auto_retry",
      onBudgetBreach: "terminate_restorable",
    },
  };

  it.each([false, true])(
    "preserves saved policy axes when checks edited=%s",
    async (editChecks) => {
      mocks.fetch.mockImplementation(async (url: string) => {
        if (url.startsWith("/api/runs/launch-options?"))
          return Response.json({
            ...preview("codex-ready"),
            executionPolicyDefault: policy,
          });

        return Response.json(
          { details: { reason: "launch_technical_precondition" } },
          { status: 422 },
        );
      });
      await openDialog();
      if (editChecks) {
        await click(button("launch.execAdvancedShow"));
        const checks = [
          ...document.querySelectorAll<HTMLSelectElement>(
            "select[aria-labelledby]",
          ),
        ].find(
          (item) =>
            document.getElementById(item.getAttribute("aria-labelledby") ?? "")
              ?.textContent === "launch.execChecks",
        );

        if (!checks) throw new Error("Checks control missing");
        await choose(checks, "advisory");
      }
      await click(button("launch.createRun"));
      const request = mocks.fetch.mock.calls.find(
        ([url]) => url === "/api/task-launch-intents",
      );

      expect(request).toBeDefined();
      expect(JSON.parse(request![1].body).executionPolicy).toEqual(
        editChecks
          ? {
              ...policy,
              overrides: { ...policy.overrides, checks: "advisory" },
            }
          : policy,
      );
    },
  );
});

describe("consensus runner binding interaction", () => {
  const receipt = (mappedRunnerId: string | null) =>
    Response.json({
      remap: {
        flowRevisionId: "revision-1",
        slotKey: SLOT_KEY,
        mappedRunnerId,
      },
    });

  it("saves a project mapping only after an explicit action", async () => {
    mocks.fetch
      .mockResolvedValueOnce(Response.json(preview(null)))
      .mockResolvedValueOnce(receipt("codex-ready"))
      .mockResolvedValueOnce(Response.json(preview("codex-ready")));
    await openDialog();
    await choose(roleSelect(), "codex-ready");
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    await click(button(`launch.runnerBindingSaveRole ${ROLE}`));
    expect(mocks.fetch.mock.calls[1][1].method).toBe("PATCH");
    expect(JSON.parse(mocks.fetch.mock.calls[1][1].body)).toEqual({
      flowRevisionId: "revision-1",
      slotKey: SLOT_KEY,
      mappedRunnerId: "codex-ready",
    });
    expect(mocks.fetch).toHaveBeenCalledTimes(3);
    expect(document.body.textContent).toContain("launch.runnerBindingSaved");
  });

  it("retains a refused selection for intentional retry", async () => {
    mocks.fetch
      .mockResolvedValueOnce(Response.json(preview("codex-ready")))
      .mockResolvedValueOnce(Response.json({}, { status: 409 }))
      .mockResolvedValueOnce(receipt(null))
      .mockResolvedValueOnce(Response.json(preview(null)));
    await openDialog();
    await choose(roleSelect(), "");
    await click(button(`launch.runnerBindingSaveRole ${ROLE}`));
    expect(roleSelect().value).toBe("");
    expect(document.querySelector("[role=alert]")?.textContent).toBe(
      "launch.runnerBindingSaveFailed",
    );
    expect(button("launch.createRun").disabled).toBe(false);
    await click(button(`launch.runnerBindingRetryRole ${ROLE}`));
    expect(
      JSON.parse(mocks.fetch.mock.calls[2][1].body).mappedRunnerId,
    ).toBeNull();
  });

  it("reads back an unconfirmed mapping without repeating the write", async () => {
    mocks.fetch
      .mockResolvedValueOnce(Response.json(preview("codex-ready")))
      .mockRejectedValueOnce(new TypeError("connection lost"))
      .mockResolvedValueOnce(
        Response.json({
          remaps: [
            {
              flowRevisionId: "revision-1",
              slotKey: SLOT_KEY,
              status: "Mapped",
              mappedRunnerId: "codex-other",
            },
          ],
        }),
      )
      .mockResolvedValueOnce(Response.json(preview("codex-other")));
    await openDialog();
    await choose(roleSelect(), "codex-other");
    await click(button(`launch.runnerBindingSaveRole ${ROLE}`));
    expect(document.querySelector("[role=alert]")?.textContent).toBe(
      "launch.runnerBindingSaveUnknown",
    );
    await click(button(`launch.runnerBindingCheckRole ${ROLE}`));
    expect(mocks.fetch.mock.calls[2][0]).toBe(
      "/api/projects/demo/flow-runner-remaps?flowRevisionId=revision-1",
    );
    expect(
      mocks.fetch.mock.calls.filter(([, init]) => init?.method === "PATCH"),
    ).toHaveLength(1);
    expect(document.body.textContent).toContain("launch.runnerBindingSaved");
  });

  it("ignores a preview for a reverted primary runner", async () => {
    const pending = deferredResponse();

    mocks.fetch
      .mockResolvedValueOnce(Response.json(preview("codex-ready")))
      .mockReturnValueOnce(pending.promise);
    await openDialog();
    await choose(primarySelect(), "codex-other");
    expect(button("launch.createRun").disabled).toBe(true);
    expect(mocks.fetch.mock.calls[1][1].method).toBe("POST");
    await choose(primarySelect(), "claude-platform");
    expect(button("launch.createRun").disabled).toBe(false);
    expect(mocks.fetch.mock.calls[1][1].signal.aborted).toBe(true);
    await act(async () => pending.resolve(Response.json(preview(null))));
    expect(button("launch.createRun").disabled).toBe(false);
  });

  it("shows status and the administrator requirement without mutation controls for members", async () => {
    mocks.fetch.mockResolvedValueOnce(Response.json(preview(null, false)));
    await openDialog();
    expect(
      document.querySelector("[data-testid=launch-runner-slots] select"),
    ).toBeNull();
    expect(document.body.textContent).toContain(
      "launch.runnerBindingAdminNeeded",
    );
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });
});

const packageVersion = {
  packageInstallId: "package-old",
  attachmentId: "attachment-1",
  packageName: "core",
  localPackageId: "local-1",
  localPackageName: "Core package",
  currentVersionLabel: "v1",
  newerCutInstallId: "package-new",
  newerVersionLabel: "v2",
  hasUncutEdits: true,
  offeredOptions: ["keep", "adopt", "cut_and_adopt", "try_once"],
};

function packageSelect(): HTMLSelectElement {
  const select = [
    ...document.querySelectorAll<HTMLSelectElement>("select[aria-labelledby]"),
  ].find(
    (item) =>
      document.getElementById(item.getAttribute("aria-labelledby") ?? "")
        ?.textContent === packageVersion.localPackageName,
  );

  if (!select) throw new Error("Package choice control is missing");

  return select;
}

describe("explicit package setup and immutable one-time preview", () => {
  const packageOptions = () => ({
    ...preview("codex-ready"),
    canManagePackages: true,
    canCutPackages: true,
    task: { ...preview("codex-ready").task, projectId: "project-1" },
    availablePackageVersions: [packageVersion],
  });

  it("discards the old runner when previewing and launching a different package cut", async () => {
    const refreshed = deferredResponse();

    mocks.fetch
      .mockResolvedValueOnce(Response.json(packageOptions()))
      .mockResolvedValueOnce(
        Response.json({
          options: { ...packageOptions(), selectedRunnerId: "codex-other" },
          enabledFlowRevisionId: "revision-1",
        }),
      )
      .mockReturnValueOnce(refreshed.promise)
      .mockResolvedValueOnce(Response.json({}, { status: 409 }));
    await openDialog();
    await choose(primarySelect(), "codex-other");
    expect(primarySelect().value).toBe("codex-other");
    await choose(packageSelect(), "try_once");
    expect(button("launch.createRun").disabled).toBe(true);
    expect(primarySelect().disabled).toBe(true);
    const query = new URL(mocks.fetch.mock.calls[2][0], "http://test")
      .searchParams;

    expect(JSON.parse(query.get("packageVersions") ?? "null")).toEqual({
      "package-old": "try_once",
    });
    expect(query.has("runnerId")).toBe(false);
    await act(async () =>
      refreshed.resolve(
        Response.json({
          ...packageOptions(),
          selectedFlowRevisionId: "revision-2",
          selectedRunnerId: "codex-ready",
          settingsToken: "selected-cut-token",
        }),
      ),
    );
    expect(primarySelect().value).toBe("codex-ready");
    expect(primarySelect().disabled).toBe(false);
    expect(button("launch.createRun").disabled).toBe(false);
    await click(button("launch.createRun"));
    const submitted = JSON.parse(mocks.fetch.mock.calls[3][1].body);

    expect(submitted).toMatchObject({
      expectedSettingsToken: "selected-cut-token",
      packageVersions: { "package-old": "try_once" },
    });
    expect(submitted).not.toHaveProperty("runnerId");
    expect(submitted).not.toHaveProperty("flowRunnerDraft");
  });

  it("applies adoption separately, then refreshes settings without launching", async () => {
    const refreshed = packageOptions();

    mocks.fetch
      .mockResolvedValueOnce(Response.json(refreshed))
      .mockResolvedValueOnce(Response.json({ status: "adopted" }))
      .mockResolvedValueOnce(
        Response.json({
          ...refreshed,
          availablePackageVersions: [],
          settingsToken: "adopted-token",
        }),
      );
    await openDialog();
    await choose(packageSelect(), "adopt");
    expect(button("launch.createRun").disabled).toBe(true);
    await click(button("launch.admission.applyPackage"));
    expect(mocks.fetch.mock.calls[1][0]).toBe(
      "/api/projects/demo/packages/attachment-1/upgrade",
    );
    expect(JSON.parse(mocks.fetch.mock.calls[1][1].body)).toEqual({
      packageInstallId: "package-new",
    });
    expect(
      mocks.fetch.mock.calls.filter(
        ([url]) => url === "/api/task-launch-intents",
      ),
    ).toHaveLength(0);
    expect(button("launch.createRun").disabled).toBe(false);
  });

  it("shows a cut's adoption failure even when the cut endpoint returns201", async () => {
    mocks.fetch
      .mockResolvedValueOnce(Response.json(packageOptions()))
      .mockResolvedValueOnce(
        Response.json(
          { adoptions: [{ projectId: "project-1", status: "failed" }] },
          { status: 201 },
        ),
      )
      .mockResolvedValueOnce(Response.json(packageOptions()));
    await openDialog();
    await choose(packageSelect(), "cut_and_adopt");
    await click(button("launch.admission.applyPackage"));
    expect(mocks.fetch.mock.calls[1][0]).toBe(
      "/api/studio/local-packages/local-1/cut-version",
    );
    expect(document.body.textContent).toContain(
      "launch.admission.setupPartial",
    );
    expect(
      mocks.fetch.mock.calls.filter(
        ([url]) => url === "/api/task-launch-intents",
      ),
    ).toHaveLength(0);
  });
});
