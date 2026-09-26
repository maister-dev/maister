// @vitest-environment jsdom

import type { ComponentProps } from "react";
import type { Root } from "react-dom/client";
import type {
  LibrarianCardView,
  LibrarianOperationView,
  LibrarianRelatedTaskView,
} from "@/lib/librarian/read-models";

import { readFileSync } from "node:fs";
import path from "node:path";

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LibrarianPanel } from "@/components/librarian/librarian-panel";
import {
  LibrarianProvider,
  type LibrarianIndicatorState,
} from "@/components/librarian/librarian-provider";
import { LibrarianTrigger } from "@/components/librarian/librarian-trigger";
import { librarianPanelMode } from "@/components/librarian/panel-mode";

// ADR-189 (T2.15): the entry, the panel's scroll rule, its named controls and
// their disabled reasons, and the `librarian` namespace in both languages.

const { pathnameRef } = vi.hoisted(() => ({ pathnameRef: { value: "/" } }));

vi.mock("next/navigation", () => ({ usePathname: () => pathnameRef.value }));
vi.mock("next-intl", () => ({
  useTranslations: () => {
    const t = (key: string, values?: Record<string, unknown>) =>
      key === "liveRunStatus" ? `${key} ${values?.status}` : key;

    t.has = () => false;

    return t;
  },
}));

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onopen: (() => void) | null = null;
  closed = false;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  close(): void {
    this.closed = true;
  }

  emit(frame: Record<string, unknown>, id = ""): void {
    this.onmessage?.(
      new MessageEvent("message", {
        data: JSON.stringify(frame),
        lastEventId: id,
      }),
    );
  }
}

type Msg = {
  id: string;
  seq: string;
  authorKind: "owner" | "librarian" | "system";
  body: string;
  deliveryState: string;
};

const message = (
  seq: number,
  authorKind: Msg["authorKind"] = "librarian",
): Msg => ({
  id: `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
  seq: String(seq),
  authorKind,
  body: `message ${seq}`,
  deliveryState: authorKind === "owner" ? "processed" : "accepted",
});

let serverMessages: Msg[] = [];
let availability = "ready";
let activeTurn: Record<string, unknown> | null = null;
let serverCards: LibrarianCardView[] = [];
let serverOperations: LibrarianOperationView[] = [];
let serverTasks: LibrarianRelatedTaskView[] = [];
let root: Root;
let container: HTMLDivElement;

function conversationView() {
  return {
    conversation: {
      id: "conv",
      runId: "11111111-1111-4111-8111-111111111111",
      resetState: "idle",
      readThroughSeq: String(serverMessages.length),
      lastSeq: String(serverMessages.length),
      memoryEnabledNextSegment: true,
      createdAt: new Date().toISOString(),
    },
    segment: { id: "seg", ordinal: 1, startedAt: new Date().toISOString() },
    indicator: { state: "none" },
    availability: { state: availability },
    pendingCards: [],
    cards: serverCards,
    operationReceipts: serverOperations,
    relatedWork: serverTasks,
    queuedMessages: [],
    activeTurn,
    pendingOperations: [],
  };
}

const fetchMock = vi.fn(
  async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input);
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });

    if (url.startsWith("/api/librarian/conversation"))
      return json(conversationView());
    if (url.startsWith("/api/librarian/cards/") && url.endsWith("/decide")) {
      serverCards = serverCards.map((card) => ({
        ...card,
        status: "accepted",
      }));

      return json({ status: "accepted" });
    }
    if (url.startsWith("/api/librarian/messages"))
      return json({
        messages: serverMessages.map((row) => ({
          ...row,
          segmentId: "seg",
          masked: false,
          subject: null,
          turnId: null,
          card: null,
          update: null,
          taskChips: [],
          usedMemoryItemIds: [],
          createdAt: new Date().toISOString(),
        })),
        hasMore: false,
      });

    return new Response(null, { status: 204 });
  },
);

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function mount(indicator: LibrarianIndicatorState = "none") {
  await act(async () => {
    root.render(
      createElement(
        LibrarianProvider,
        {
          initialIndicator: indicator,
          ownerId: "owner-1",
        } as ComponentProps<typeof LibrarianProvider>,
        createElement(LibrarianTrigger),
        createElement(LibrarianPanel),
      ),
    );
  });
}

const q = <T extends Element = HTMLElement>(testId: string) =>
  container.querySelector<T>(`[data-testid="${testId}"]`);

async function openPanel(): Promise<void> {
  await act(async () => {
    q<HTMLButtonElement>("librarian-trigger")!.click();
  });
  await flush();
}

/** jsdom has no layout: give the list a height and a settable scroll. */
function fakeScroll(list: HTMLElement, scrollHeight: number) {
  let top = 0;

  Object.defineProperty(list, "scrollHeight", {
    configurable: true,
    get: () => scrollHeight,
  });
  Object.defineProperty(list, "clientHeight", {
    configurable: true,
    get: () => 200,
  });
  Object.defineProperty(list, "scrollTop", {
    configurable: true,
    get: () => top,
    set: (value: number) => {
      top = value;
    },
  });

  return {
    scrollTo(value: number) {
      top = value;
      list.dispatchEvent(new Event("scroll"));
    },
    get top() {
      return top;
    },
  };
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal("fetch", fetchMock);
  FakeEventSource.instances = [];
  fetchMock.mockClear();
  serverMessages = [message(1, "owner"), message(2)];
  availability = "ready";
  activeTurn = null;
  serverCards = [];
  serverOperations = [];
  serverTasks = [];
  pathnameRef.value = "/";
  window.localStorage.clear();
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: 1440,
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

describe("IT-LUI-10: linked work and confirmation cards", () => {
  it("shows a statement diff, records the owner's click, and updates the card state", async () => {
    serverCards = [
      {
        id: "card-1",
        kind: "statement_proposal",
        status: "pending",
        action: "statement_accept",
        target: { projectId: "project-1", taskId: "task-1" },
        targetRevision: "2",
        payload: {},
        currentPrompt: "Old goal",
        proposedPrompt: "New goal",
        available: true,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    ];
    serverOperations = [
      {
        id: "operation-1",
        kind: "run_launch",
        status: "succeeded",
        result: { runId: "run-1", status: "Pending", queuePosition: 2 },
        liveRunStatus: "Running",
        available: true,
        createdAt: new Date().toISOString(),
      },
    ];
    serverTasks = [
      {
        taskId: "task-1",
        meaning: "refined_in",
        fromMessageId: null,
        toMessageId: null,
        available: false,
        projectSlug: null,
        number: null,
        title: null,
        status: null,
      },
    ];

    await mount();
    await openPanel();
    expect(q("librarian-statement-diff")?.textContent).toContain("Old goal");
    expect(q("librarian-statement-diff")?.textContent).toContain("New goal");
    expect(q("librarian-linked-work")?.textContent).toContain("Running");
    expect(q("librarian-linked-work")?.textContent).toContain(
      "linkedUnavailable",
    );

    const card = q("librarian-card-pending")!;

    await act(async () => {
      card.querySelector<HTMLButtonElement>("button")!.click();
    });
    await flush();
    const request = fetchMock.mock.calls.find(([input]) =>
      String(input).endsWith("/cards/card-1/decide"),
    );

    expect(request?.[1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({ decision: "accept", expectedRevision: 2 }),
    });
    expect(q("librarian-card-accepted")).not.toBeNull();
    expect(q("librarian-card-accepted")?.querySelector("button")).toBeNull();
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("UT-LUI-01: the entry shows a state, never a number", () => {
  it("names the indicator state and renders it as a dot", async () => {
    await mount("running");
    const trigger = q<HTMLButtonElement>("librarian-trigger")!;

    expect(trigger.getAttribute("aria-label")).toBe(
      "entryLabel — indicator_running",
    );
    expect(trigger.dataset.indicator).toBe("running");
    expect(q("librarian-indicator-dot")!.className).toContain("bg-mute");
    expect(trigger.textContent).not.toMatch(/\d/);
  });

  it("wears the attention tone only for action_required, and nothing for none", async () => {
    await mount("action_required");
    expect(q("librarian-indicator-dot")!.className).toContain("bg-amber");
    await act(async () => root.unmount());
    root = createRoot(container);
    await mount("none");
    expect(q("librarian-indicator-dot")).toBeNull();
    expect(q("librarian-trigger")!.getAttribute("aria-label")).toBe(
      "entryLabel",
    );
  });

  it("follows librarian.indicator frames from the stream", async () => {
    await mount("none");
    const source = FakeEventSource.instances[0];

    expect(source.url).toContain("/api/librarian/stream");
    await act(async () => {
      source.emit({ type: "librarian.indicator", state: "unread" }, "7");
    });
    expect(q("librarian-trigger")!.dataset.indicator).toBe("unread");
    expect(q("librarian-trigger")!.textContent).not.toMatch(/\d/);
  });
});

describe("UT-LUI-06: arriving messages never move a reader who scrolled up", () => {
  it("keeps the scroll position and offers jump-to-latest", async () => {
    await mount();
    await openPanel();
    const list = q("librarian-transcript")!;

    expect(list.textContent).toContain("message 2");
    const scroll = fakeScroll(list, 1000);

    await act(async () => scroll.scrollTo(100));
    serverMessages = [...serverMessages, message(3)];
    await act(async () => {
      FakeEventSource.instances[0].emit({ type: "librarian.message" }, "3");
    });
    await flush();

    expect(list.textContent).toContain("message 3");
    expect(scroll.top).toBe(100);
    const jump = q<HTMLButtonElement>("librarian-jump-latest")!;

    expect(jump.textContent).toContain("jumpToLatest");
    await act(async () => jump.click());
    expect(scroll.top).toBe(1000);
    expect(q("librarian-jump-latest")).toBeNull();
  });

  it("follows a reader who is already at the bottom", async () => {
    await mount();
    await openPanel();
    const list = q("librarian-transcript")!;
    const scroll = fakeScroll(list, 1000);

    await act(async () => scroll.scrollTo(800));
    serverMessages = [...serverMessages, message(3)];
    await act(async () => {
      FakeEventSource.instances[0].emit({ type: "librarian.message" }, "3");
    });
    await flush();

    expect(scroll.top).toBe(1000);
    expect(q("librarian-jump-latest")).toBeNull();
  });
});

describe("UT-LUI-07: named controls, each disabled one states its reason", () => {
  function reasonOf(control: HTMLElement): string | null {
    const id = control.getAttribute("aria-describedby");

    return id ? (container.querySelector(`#${id}`)?.textContent ?? null) : null;
  }

  it("Stop response is its own control and never a run action", async () => {
    await mount();
    await openPanel();
    const stop = q<HTMLButtonElement>("librarian-stop-response")!;
    const names = [...container.querySelectorAll("button")].map(
      (button) => button.textContent ?? "",
    );

    expect(stop.textContent).toContain("stopResponse");
    expect(names.some((name) => name.includes("stopRun"))).toBe(false);
    expect(stop.disabled).toBe(true);
    expect(reasonOf(stop)).toBe("stopBlocked");
  });

  it("states why Send is disabled: empty draft, disabled librarian, no runner", async () => {
    await mount();
    await openPanel();
    const send = () => q<HTMLButtonElement>("librarian-send")!;

    expect(send().disabled).toBe(true);
    expect(reasonOf(send())).toBe("sendBlocked_empty");
    await act(async () => root.unmount());

    for (const [state, reason] of [
      ["disabled", "sendBlocked_disabled"],
      ["not_configured", "sendBlocked_no_runner"],
      ["runner_not_ready", "sendBlocked_no_runner"],
    ] as const) {
      availability = state;
      root = createRoot(container);
      await mount();
      await openPanel();
      expect(send().disabled).toBe(true);
      expect(reasonOf(send())).toBe(reason);
      expect(q("librarian-availability")!.textContent).toBe(
        `availability_${state}`,
      );
      await act(async () => root.unmount());
    }
    root = createRoot(container);
  });

  it("enables Stop response while a turn is active and posts only the turn stop", async () => {
    activeTurn = {
      id: "turn",
      variant: "owner_message",
      status: "admitted",
      failureReason: null,
      queuePosition: 2,
      messageId: null,
      createdAt: new Date().toISOString(),
      startedAt: null,
      endedAt: null,
      deadlineAt: null,
    };
    await mount();
    await openPanel();
    const stop = q<HTMLButtonElement>("librarian-stop-response")!;

    expect(stop.disabled).toBe(false);
    expect(q("librarian-waiting")!.textContent).toBe("waitingForSlot");
    await act(async () => stop.click());
    await flush();
    expect(
      fetchMock.mock.calls.filter(([url]) => String(url).includes("/stop")),
    ).toEqual([["/api/librarian/turns/current/stop", { method: "POST" }]]);
  });
});

describe("LUI-05 / LUI-02 in the unit: focus and the kept draft", () => {
  it("focuses the composer on open and returns focus to the entry on close", async () => {
    await mount();
    q<HTMLButtonElement>("librarian-trigger")!.focus();
    await openPanel();
    expect(document.activeElement).toBe(q("librarian-composer"));
    await act(async () => q<HTMLButtonElement>("librarian-close")!.click());
    expect(document.activeElement).toBe(q("librarian-trigger"));
  });

  it("keeps the draft per user across a remount, and survives blocked storage", async () => {
    await mount();
    await openPanel();
    const composer = q<HTMLTextAreaElement>("librarian-composer")!;
    const setValue = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )!.set!;

    await act(async () => {
      setValue.call(composer, "half a thought");
      composer.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(window.localStorage.getItem("maister.librarian.draft.owner-1")).toBe(
      "half a thought",
    );
    await act(async () => root.unmount());
    root = createRoot(container);
    await mount();
    expect(q<HTMLTextAreaElement>("librarian-composer")!.value).toBe(
      "half a thought",
    );
    await act(async () => root.unmount());
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    root = createRoot(container);
    await mount();
    expect(q<HTMLTextAreaElement>("librarian-composer")!.value).toBe("");
    vi.restoreAllMocks();
  });
});

describe("ADR-189 D4: the presentation rule", () => {
  const cases: [number, string, boolean, string][] = [
    [390, "/", false, "fullscreen"],
    [390, "/scratch-runs/x", true, "fullscreen"],
    [1440, "/scratch-runs/x", true, "sheet"],
    [1440, "/runs/abc", false, "sheet"],
    [1600, "/runs/abc", false, "docked"],
    [1440, "/studio/local/pkg", false, "sheet"],
    [1024, "/", false, "sheet"],
    [1280, "/projects/demo", false, "docked"],
    [1440, "/", false, "docked"],
  ];

  it.each(cases)(
    "%i px on %s (host composer %s) → %s",
    (width, route, host, mode) => {
      expect(
        librarianPanelMode({
          viewportWidth: width,
          pathname: route,
          hostComposerVisible: host,
        }),
      ).toBe(mode);
    },
  );

  it("docked is a complementary landmark, the sheet a modal dialog", async () => {
    await mount();
    await openPanel();
    expect(q("librarian-panel")!.getAttribute("role")).toBe("complementary");
    expect(q("librarian-panel")!.getAttribute("aria-modal")).toBeNull();
    await act(async () => root.unmount());
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1024,
    });
    root = createRoot(container);
    await mount();
    await openPanel();
    expect(q("librarian-panel")!.getAttribute("role")).toBe("dialog");
    expect(q("librarian-panel")!.getAttribute("aria-modal")).toBe("true");
  });
});

describe("UT-LUI-08: the librarian namespace in EN and RU", () => {
  const load = (locale: string) =>
    JSON.parse(
      readFileSync(path.join(process.cwd(), `messages/${locale}.json`), "utf8"),
    ).librarian as Record<string, string>;

  it("has the same keys in both catalogs, every value distinct", () => {
    const en = load("en");
    const ru = load("ru");

    expect(Object.keys(ru).sort()).toEqual(Object.keys(en).sort());
    for (const key of Object.keys(en)) {
      expect(ru[key], key).toBeTruthy();
      expect(ru[key], key).not.toBe(en[key]);
    }
    expect(en.entryLabel).toBe("Librarian");
    expect(ru.entryLabel).toBe("Библиотекарь");
    expect(ru.subjectGeneral).toBe("Общий вопрос");
  });

  it("covers every key the panel and the entry ask for", () => {
    const en = load("en");
    const sources = [
      "components/librarian/librarian-panel.tsx",
      "components/librarian/librarian-trigger.tsx",
    ].map((file) => readFileSync(path.join(process.cwd(), file), "utf8"));
    const keys = new Set<string>();

    for (const source of sources)
      for (const match of source.matchAll(/\bt\("([A-Za-z_]+)"/g))
        keys.add(match[1]);

    for (const key of keys) expect(en[key], key).toBeTruthy();
    for (const prefix of ["availability_", "sendBlocked_", "indicator_"])
      expect(Object.keys(en).some((key) => key.startsWith(prefix))).toBe(true);
  });
});
