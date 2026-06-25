// @vitest-environment jsdom

// P1.5 (ADR-110): the per-instance agent-config section of the attach/edit
// modal renders ONE control per declared `config_schema` param (seeded from the
// effective value = instance config ?? declared default) and folds the
// collected values into the SAME aggregating PATCH body (`configValues`) — one
// fetch, no extra round-trip.

import type {
  AttachedAgentRow,
  AgentRecommendedView,
} from "@/components/board/panels/agents-attach-panel";
import type { AgentConfigParam } from "@/lib/agents/definition";

import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
  useTranslations:
    (namespace: string) =>
    (key: string): string =>
      `${namespace}.${key}`,
}));

import { AttachEditModal } from "@/components/board/panels/agents-attach-edit-modal";

type FetchLike = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) => Promise<Response>;

const roots: Root[] = [];

const CONFIG_SCHEMA: AgentConfigParam[] = [
  {
    key: "detect_duplicates",
    type: "boolean",
    default: true,
    label: "Detect duplicates",
    description: "Flag likely-duplicate tasks.",
  },
  {
    key: "auto_enqueue",
    type: "enum",
    values: ["off", "when_confident", "always"],
    default: "off",
    label: "Auto enqueue",
  },
  { key: "intake_note", type: "string", default: "triage" },
  { key: "max_rounds", type: "number", default: 3 },
];

function buildRow(over?: {
  configSchema?: AgentConfigParam[] | null;
  config?: Record<string, unknown> | null;
}): AttachedAgentRow {
  const recommended: AgentRecommendedView | null = null;

  return {
    linkId: "link-1",
    enabled: true,
    runnerOverrideId: null,
    branchBase: null,
    executionPolicyOverride: null,
    config: over?.config ?? null,
    schedules: [],
    agent: {
      id: "core:triager",
      name: "triager",
      packageName: "core",
      workspace: "none",
      mode: "session",
      triggers: ["manual"],
      riskTier: "read_only",
      enabled: true,
      quarantinedAt: null,
      recommended,
      configSchema:
        over?.configSchema === undefined ? CONFIG_SCHEMA : over.configSchema,
    },
  };
}

function render(row: AttachedAgentRow): { container: HTMLDivElement } {
  const container = document.createElement("div");
  const root = createRoot(container);

  document.body.appendChild(container);
  roots.push(root);

  act(() => {
    root.render(
      createElement(AttachEditModal, {
        slug: "proj",
        row,
        runners: [],
        eventKinds: [],
        onClose() {},
        onSaved() {},
      }),
    );
  });

  return { container };
}

function findByTestId<T extends HTMLElement>(id: string): T {
  const el = document.body.querySelector<T>(`[data-testid="${id}"]`);

  if (!el) throw new Error(`testid not found: ${id}`);

  return el;
}

function findButton(label: string): HTMLButtonElement {
  const button = Array.from(document.body.querySelectorAll("button")).find(
    (item) => (item.textContent ?? "").includes(label),
  );

  if (!button) throw new Error(`button not found: ${label}`);

  return button;
}

async function click(element: Element): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

async function setValue(
  element: HTMLInputElement | HTMLSelectElement,
  value: string,
): Promise<void> {
  await act(async () => {
    const prototype =
      element instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;

    setter?.call(element, value);
    element.dispatchEvent(
      new Event(element instanceof HTMLSelectElement ? "change" : "input", {
        bubbles: true,
      }),
    );
  });
}

// A native click toggles `checked` and fires React's onChange with the toggled
// value — more reliable than poking the `checked` setter under act().
async function toggleCheckbox(element: HTMLInputElement): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  for (const root of roots) act(() => root.unmount());
  roots.length = 0;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe("AttachEditModal configuration section (ADR-110)", () => {
  it("renders one control per declared param seeded from the effective value", () => {
    render(buildRow({ config: { auto_enqueue: "always" } }));

    // boolean → checkbox seeded from default (true)
    const boolean = findByTestId<HTMLInputElement>("config-detect_duplicates");

    expect(boolean.type).toBe("checkbox");
    expect(boolean.checked).toBe(true);

    // enum → select seeded from the INSTANCE value (overrides default)
    const enumSel = findByTestId<HTMLSelectElement>("config-auto_enqueue");

    expect(enumSel.tagName).toBe("SELECT");
    expect(enumSel.value).toBe("always");
    expect(
      Array.from(enumSel.querySelectorAll("option")).map((o) => o.value),
    ).toEqual(["off", "when_confident", "always"]);

    // string → text input seeded from default
    const text = findByTestId<HTMLInputElement>("config-intake_note");

    expect(text.value).toBe("triage");

    // number → number input seeded from default
    const num = findByTestId<HTMLInputElement>("config-max_rounds");

    expect(num.type).toBe("number");
    expect(num.value).toBe("3");
  });

  it("renders no configuration section when the agent declares no params", () => {
    render(buildRow({ configSchema: null }));

    expect(
      document.body.querySelector('[data-testid="config-section"]'),
    ).toBeNull();
  });

  it("folds edited values into ONE aggregating PATCH (configValues in the body)", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchMock = vi.fn<FetchLike>(async (input, init) => {
      calls.push({
        url: String(input),
        body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      });

      return new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json" },
      });
    });

    vi.stubGlobal("fetch", fetchMock);

    render(buildRow());

    // Flip the boolean off, switch the enum, edit string + number.
    await toggleCheckbox(
      findByTestId<HTMLInputElement>("config-detect_duplicates"),
    );
    await setValue(
      findByTestId<HTMLSelectElement>("config-auto_enqueue"),
      "when_confident",
    );
    await setValue(
      findByTestId<HTMLInputElement>("config-intake_note"),
      "deep",
    );
    await setValue(findByTestId<HTMLInputElement>("config-max_rounds"), "5");

    await click(findButton("agentsAttach.save"));
    await flush();

    // Exactly one PATCH to the agent endpoint (single aggregating call).
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(calls[0].url).toBe("/api/projects/proj/agents/core:triager");
    expect(calls[0].body.configValues).toEqual({
      detect_duplicates: false,
      auto_enqueue: "when_confident",
      intake_note: "deep",
      max_rounds: 5,
    });
    // The other aggregating fields ride the same body.
    expect(calls[0].body).toHaveProperty("enabled");
    expect(calls[0].body).toHaveProperty("schedules");
  });
});
