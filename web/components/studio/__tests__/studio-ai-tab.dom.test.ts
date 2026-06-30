// @vitest-environment jsdom

import type { Root } from "react-dom/client";

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// next-intl identity: `tScratch("launchStage.materializing")` → the key string,
// which lets the test assert the staged label without a real catalog. The
// translator MUST be a stable reference — StudioAiTab's runner-load effect
// depends on `t`, so a fresh fn per render would re-fire it every render.
const stubTranslate = Object.assign((key: string) => key, {
  raw: (key: string) => key,
});

vi.mock("next-intl", () => ({ useTranslations: () => stubTranslate }));
vi.mock("@/lib/use-run-stream", () => ({
  useRunStream: () => ({ eventCount: 0 }),
}));
vi.mock("@/components/scratch/scratch-conversation", () => ({
  ScratchConversation: () =>
    createElement("div", { "data-testid": "scratch-conversation-stub" }),
}));
vi.mock("@/components/studio/flow-assistant-action-result", () => ({
  FlowAssistantActionResult: () => null,
}));
vi.mock("@/components/capabilities/capability-composer", () => ({
  CapabilityComposer: (props: {
    value: string;
    testId: string;
    onChange: (v: string) => void;
  }) =>
    createElement("textarea", {
      "data-testid": props.testId,
      value: props.value,
      onChange: (e: { target: { value: string } }) =>
        props.onChange(e.target.value),
    }),
}));
vi.mock("@/lib/capabilities/package-catalog", () => ({
  buildPackageCapabilityCatalog: () => [],
}));
vi.mock("@/lib/api-error", () => ({
  readApiError: async (res: Response) => {
    const body = (await res.json().catch(() => null)) as {
      message?: string;
    } | null;

    return body?.message ?? "error";
  },
}));

import { StudioAiTab } from "@/components/studio/studio-ai-tab";

const labels = {
  intro: "intro",
  promptPlaceholder: "placeholder",
  launch: "Launch",
  launching: "Launching…",
  drop: "Drop",
  lockRequired: "lock required",
  runner: "Runner",
  loadingRunners: "loading",
  noRunners: "no runners",
  saveCurrentChanges: "save",
  actionResult: {} as never,
};

const roots: Root[] = [];
const encoder = new TextEncoder();

let assistantResponse: () => Response;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
  const url = typeof input === "string" ? input : input.toString();

  if (url.endsWith("/assistant/runners")) {
    return jsonResponse({
      runners: [
        {
          id: "runner-1",
          label: "runner-1 · m",
          adapter: "claude",
          model: "m",
          isDefault: true,
        },
      ],
      defaultRunnerId: "runner-1",
    });
  }
  if (url.endsWith("/lock-refresh")) return jsonResponse({ heldByMe: true });
  if (url.endsWith("/assistant")) return assistantResponse();
  throw new Error(`unexpected fetch: ${url}`);
});

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockClear();
});

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  vi.unstubAllGlobals();
});

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function mount(extra: Record<string, unknown> = {}): HTMLDivElement {
  const container = document.createElement("div");

  document.body.appendChild(container);
  const root = createRoot(container);

  roots.push(root);
  act(() =>
    root.render(
      createElement(StudioAiTab, {
        packageId: "pkg-1",
        sessionId: "sess-1",
        canManage: true,
        labels,
        files: [],
        onBusyChange: vi.fn(),
        onActivity: vi.fn(),
        ...extra,
      } as never),
    ),
  );

  return container;
}

function setTextarea(el: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    "value",
  )?.set;

  act(() => {
    setter?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function mountAndPrime(
  extra: Record<string, unknown> = {},
): Promise<HTMLDivElement> {
  const container = mount(extra);

  await flush(); // runners load → selectedRunnerId set

  const textarea = container.querySelector<HTMLTextAreaElement>(
    '[data-testid="studio-ai-prompt"]',
  );

  expect(textarea).not.toBeNull();
  setTextarea(textarea as HTMLTextAreaElement, "add a flow");

  return container;
}

describe("StudioAiTab runner selector", () => {
  it("renders the runner labels returned by the assistant runners API", async () => {
    const container = mount();

    await flush();

    const option = container.querySelector<HTMLOptionElement>(
      '[data-testid="studio-ai-runner"] option',
    );

    expect(option?.textContent).toBe("runner-1 · m");
  });
});

describe("StudioAiTab staged launch (ADR-110 addendum)", () => {
  it("shows the stage label while launching and switches to the conversation view on session_ready, before the terminal frame (AC7/AC11)", async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
    });

    assistantResponse = () =>
      new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });

    const onBusyChange = vi.fn();
    const container = await mountAndPrime({ onBusyChange });
    const launchBtn = container.querySelector<HTMLButtonElement>(
      '[data-testid="studio-ai-launch"]',
    );

    expect(launchBtn).not.toBeNull();
    act(() => launchBtn?.click());
    await flush(); // ensureLockHeld + assistant fetch resolve

    const emit = async (frame: Record<string, unknown>): Promise<void> => {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
      await flush();
    };

    await emit({ type: "scratch.launch_progress", stage: "precondition" });
    await emit({
      type: "scratch.launch_progress",
      stage: "materializing",
      adapter: "claude",
    });

    // Mid-launch (no session_ready yet): still the launch view, button shows the
    // current stage label, no conversation surface yet, editor NOT yet marked
    // busy (read-only must not engage before the turn starts).
    expect(
      container.querySelector('[data-testid="scratch-conversation-stub"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="studio-ai-launch"]')?.textContent,
    ).toBe("launchStage.materializing");
    expect(onBusyChange).not.toHaveBeenCalledWith(true);

    await emit({ type: "scratch.launch_progress", stage: "spawning" });
    await emit({
      type: "scratch.launch_progress",
      stage: "session_ready",
      runId: "run-9",
      dialogUrl: "/scratch-runs/run-9",
    });

    // session_ready set runId → the conversation surface mounts AND the editor
    // is marked busy (read-only) BEFORE the terminal result frame is sent, so
    // user edits cannot race the first turn.
    expect(
      container.querySelector('[data-testid="scratch-conversation-stub"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="studio-ai-launch"]'),
    ).toBeNull();
    expect(onBusyChange).toHaveBeenCalledWith(true);

    await emit({
      type: "scratch.launch_result",
      result: { runId: "run-9", dialogStatus: "Running", actionResult: null },
    });
    act(() => controller.close());
    await flush();

    // Stays in the conversation view after the terminal frame; no error.
    expect(
      container.querySelector('[data-testid="scratch-conversation-stub"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="studio-ai-error"]'),
    ).toBeNull();
  });

  it("sets the error banner without a runId when the response is a JSON gate error (AC5 client side)", async () => {
    assistantResponse = () =>
      jsonResponse({ code: "CONFLICT", message: "editor lock not held" }, 409);

    const container = await mountAndPrime();
    const launchBtn = container.querySelector<HTMLButtonElement>(
      '[data-testid="studio-ai-launch"]',
    );

    act(() => launchBtn?.click());
    await flush();

    const error = container.querySelector('[data-testid="studio-ai-error"]');

    expect(error?.textContent).toContain("editor lock not held");
    // Still the launch view (runId never set) — no conversation surface.
    expect(
      container.querySelector('[data-testid="scratch-conversation-stub"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="studio-ai-launch"]'),
    ).not.toBeNull();
  });
});
