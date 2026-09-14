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
    task: { projectSlug: "demo", number: 1, flowId: "flow-1" },
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
    "[data-testid=launch-consensus-runners] select",
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
  vi.clearAllMocks();
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

describe("consensus runner binding interaction", () => {
  it("saves exactly one selected binding, refreshes before enabling launch, and supports reset", async () => {
    const save = deferredResponse();
    const refreshed = deferredResponse();

    mocks.fetch
      .mockResolvedValueOnce(Response.json(preview(null)))
      .mockReturnValueOnce(save.promise)
      .mockReturnValueOnce(refreshed.promise)
      .mockResolvedValueOnce(Response.json({}))
      .mockResolvedValueOnce(Response.json(preview(null)));
    await openDialog();
    expect(button("launch.createRun").disabled).toBe(true);
    expect(roleSelect().value).toBe("");
    await choose(roleSelect(), "codex-other");
    await click(button(`launch.consensusBindingSaveRole ${ROLE}`));

    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    expect(mocks.fetch.mock.calls[1][0]).toBe(
      "/api/projects/demo/flow-runner-remaps",
    );
    expect(JSON.parse(mocks.fetch.mock.calls[1][1].body)).toEqual({
      flowRevisionId: "revision-1",
      slotKey: SLOT_KEY,
      mappedRunnerId: "codex-other",
    });
    expect(button("launch.createRun").disabled).toBe(true);
    await act(async () => save.resolve(Response.json({})));
    expect(mocks.fetch).toHaveBeenCalledTimes(3);
    expect(button("launch.createRun").disabled).toBe(true);
    await act(async () =>
      refreshed.resolve(Response.json(preview("codex-other"))),
    );
    expect(button("launch.createRun").disabled).toBe(false);
    expect(roleSelect().value).toBe("codex-other");

    await choose(roleSelect(), "");
    await click(button(`launch.consensusBindingSaveRole ${ROLE}`));
    expect(
      JSON.parse(mocks.fetch.mock.calls[3][1].body).mappedRunnerId,
    ).toBeNull();
    expect(button("launch.createRun").disabled).toBe(true);
    expect(roleSelect().value).toBe("");
  });

  it("retains a failed selection and allows an explicit retry without optimistic unblocking", async () => {
    mocks.fetch
      .mockResolvedValueOnce(Response.json(preview(null)))
      .mockResolvedValueOnce(
        Response.json({ code: "PRECONDITION" }, { status: 409 }),
      )
      .mockResolvedValueOnce(Response.json({}))
      .mockResolvedValueOnce(Response.json(preview("codex-ready")));
    await openDialog();
    await choose(roleSelect(), "codex-ready");
    await click(button(`launch.consensusBindingSaveRole ${ROLE}`));
    expect(roleSelect().value).toBe("codex-ready");
    expect(document.querySelector("[role=alert]")?.textContent).toBe(
      "launch.consensusBindingSaveFailed",
    );
    expect(button("launch.createRun").disabled).toBe(true);
    expect(button(`launch.consensusBindingSaveRole ${ROLE}`).disabled).toBe(
      false,
    );
    await click(button(`launch.consensusBindingSaveRole ${ROLE}`));
    expect(button("launch.createRun").disabled).toBe(false);
  });

  it("retries a failed preview after a saved binding while preserving the selection", async () => {
    mocks.fetch
      .mockResolvedValueOnce(Response.json(preview(null)))
      .mockResolvedValueOnce(Response.json({}))
      .mockResolvedValueOnce(Response.json({ code: "CRASH" }, { status: 500 }))
      .mockResolvedValueOnce(Response.json(preview("codex-other")));
    await openDialog();
    await choose(roleSelect(), "codex-other");
    await click(button(`launch.consensusBindingSaveRole ${ROLE}`));
    expect(button("launch.createRun").disabled).toBe(true);
    expect(roleSelect().value).toBe("codex-other");
    expect(document.querySelector("[role=alert]")?.textContent).toBe(
      "launch.optionsError",
    );
    expect(document.body.textContent).not.toContain("launch.loading");
    await click(button("launch.retryPreview"));
    expect(button("launch.createRun").disabled).toBe(false);
    expect(roleSelect().value).toBe("codex-other");
    expect(
      mocks.fetch.mock.calls.filter(([, init]) => init?.method === "PATCH"),
    ).toHaveLength(1);
  });

  it("prevents binding edits and saves while a launch request is in flight", async () => {
    const launch = deferredResponse();

    mocks.fetch
      .mockResolvedValueOnce(Response.json(preview("codex-ready")))
      .mockReturnValueOnce(launch.promise);
    await openDialog();
    await choose(roleSelect(), "codex-other");
    await click(button("launch.createRun"));
    expect(roleSelect().disabled).toBe(true);
    expect(button(`launch.consensusBindingSaveRole ${ROLE}`).disabled).toBe(
      true,
    );
    await click(button(`launch.consensusBindingSaveRole ${ROLE}`));
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    expect(mocks.fetch.mock.calls[1][1].method).toBe("POST");
    await act(async () =>
      launch.resolve(Response.json({ code: "CONFIG" }, { status: 400 })),
    );
    expect(roleSelect().disabled).toBe(false);
  });

  it("reverting a primary runner while refresh is pending restores the prior preview and ignores the stale response", async () => {
    const pending = deferredResponse();

    mocks.fetch
      .mockResolvedValueOnce(Response.json(preview("codex-ready")))
      .mockReturnValueOnce(pending.promise);
    await openDialog();
    expect(button("launch.createRun").disabled).toBe(false);
    await choose(primarySelect(), "codex-other");
    expect(button("launch.createRun").disabled).toBe(true);
    await choose(primarySelect(), "claude-platform");
    expect(button("launch.createRun").disabled).toBe(false);
    expect(mocks.fetch.mock.calls[1][1].signal.aborted).toBe(true);
    await act(async () => pending.resolve(Response.json(preview(null))));
    expect(button("launch.createRun").disabled).toBe(false);
    expect(document.querySelector("[role=status]")?.textContent).not.toBe(
      "launch.loading",
    );
  });

  it("shows status and the administrator requirement without mutation controls for members", async () => {
    mocks.fetch.mockResolvedValueOnce(Response.json(preview(null, false)));
    await openDialog();
    expect(
      document.querySelector("[data-testid=launch-consensus-runners] select"),
    ).toBeNull();
    expect(document.body.textContent).toContain(
      "launch.consensusBindingAdminNeeded",
    );
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });
});
