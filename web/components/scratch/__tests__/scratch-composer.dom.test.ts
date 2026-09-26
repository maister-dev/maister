// @vitest-environment jsdom

import type { Root } from "react-dom/client";

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("next-intl", () => ({
  useTranslations: (namespace: string) => (key: string) =>
    `${namespace}.${key}`,
}));

vi.mock("@/components/capabilities/capability-composer", () => ({
  CapabilityComposer: (props: {
    onChange: (value: string) => void;
    onSubmitShortcut?: () => void;
    testId?: string;
    value: string;
  }) =>
    createElement("textarea", {
      "data-testid": props.testId,
      value: props.value,
      onChange: (event: { currentTarget: { value: string } }) =>
        props.onChange(event.currentTarget.value),
      onKeyDown: (event: {
        key: string;
        metaKey: boolean;
        ctrlKey: boolean;
      }) => {
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey))
          props.onSubmitShortcut?.();
      },
    }),
}));

import { ScratchComposer } from "@/components/scratch/scratch-composer";

const roots: Root[] = [];

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });

  return { promise, resolve };
}

function mount(onSend: () => Promise<boolean>): HTMLDivElement {
  const container = document.createElement("div");
  const root = createRoot(container);

  document.body.appendChild(container);
  roots.push(root);

  act(() => {
    root.render(
      createElement(ScratchComposer, {
        status: "WaitingForUser",
        pending: false,
        quickReplies: [],
        onRecover: async () => true,
        onSend: async (payload) => {
          expect(payload.content).toBe("ship it");

          return onSend();
        },
      }),
    );
  });

  return container;
}

function setTextarea(textarea: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    "value",
  )?.set;

  act(() => {
    setter?.call(textarea, value);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await act(async () => root.unmount());
  }
});

describe("ScratchComposer draft clearing", () => {
  it("clears the draft immediately after submit while onSend is still pending", async () => {
    const send = deferred<boolean>();
    const container = mount(() => send.promise);
    const textarea = container.querySelector<HTMLTextAreaElement>(
      '[data-testid="scratch-message-composer"]',
    );
    const button = container.querySelector<HTMLButtonElement>(
      '[data-testid="scratch-composer-send"]',
    );

    expect(textarea).not.toBeNull();
    expect(button).not.toBeNull();
    setTextarea(textarea as HTMLTextAreaElement, "ship it");

    act(() => {
      button?.click();
    });
    await flush();

    expect(
      container.querySelector<HTMLTextAreaElement>(
        '[data-testid="scratch-message-composer"]',
      )?.value,
    ).toBe("");

    send.resolve(true);
    await flush();
  });
});

// ADR-182 D-D4: the browser-side auto-send queue is deleted. A message typed
// while the agent is busy leaves the browser at once (the server steers or
// queues it), so a reload has nothing client-side to lose, and nothing fires
// later on its own.
describe("ScratchComposer while the agent is busy", () => {
  type BusyStatus = "Starting" | "Running" | "WaitingForUser";

  function mountBusy(props: {
    status: BusyStatus;
    // The POST that started the running turn is still in flight — it stays
    // pending for the whole turn.
    pending?: boolean;
    onSend: (payload: { content: string }) => Promise<boolean>;
    onInterrupt: () => Promise<boolean>;
  }): {
    container: HTMLDivElement;
    rerender: (status: BusyStatus) => void;
  } {
    const container = document.createElement("div");
    const root = createRoot(container);
    const render = (status: BusyStatus): void => {
      act(() => {
        root.render(
          createElement(ScratchComposer, {
            status,
            pending: props.pending ?? false,
            quickReplies: [],
            sendWhileBusy: true,
            onRecover: async () => true,
            onSend: props.onSend,
            onInterrupt: props.onInterrupt,
          }),
        );
      });
    };

    document.body.appendChild(container);
    roots.push(root);
    render(props.status);

    return { container, rerender: render };
  }

  it("sends a message typed while Running immediately and keeps no client queue", async () => {
    const sent: string[] = [];
    const busy = mountBusy({
      status: "Running",
      onSend: async (payload) => {
        sent.push(payload.content);

        return true;
      },
      onInterrupt: async () => true,
    });
    const textarea = busy.container.querySelector<HTMLTextAreaElement>(
      '[data-testid="scratch-message-composer"]',
    ) as HTMLTextAreaElement;

    setTextarea(textarea, "also check the migration");
    act(() => {
      busy.container
        .querySelector<HTMLButtonElement>(
          '[data-testid="scratch-composer-send"]',
        )
        ?.click();
    });
    await flush();
    expect(sent).toEqual(["also check the migration"]);
    expect(textarea.value).toBe("");

    // The turn ends: nothing was held back, so nothing sends by itself.
    busy.rerender("WaitingForUser");
    await flush();
    expect(sent).toEqual(["also check the migration"]);
  });

  it("Stop no longer arms an auto-send: a draft is only ever sent by the user", async () => {
    const sent: string[] = [];
    const first = mountBusy({
      status: "Running",
      onSend: async (payload) => {
        sent.push(payload.content);

        return true;
      },
      onInterrupt: async () => true,
    });

    setTextarea(
      first.container.querySelector<HTMLTextAreaElement>(
        '[data-testid="scratch-message-composer"]',
      ) as HTMLTextAreaElement,
      "draft only",
    );
    act(() => {
      first.container
        .querySelector<HTMLButtonElement>(
          '[data-testid="scratch-composer-stop"]',
        )
        ?.click();
    });
    await flush();
    first.rerender("WaitingForUser");
    await flush();
    // A draft is only ever sent by the user: the Stop click did not queue it.
    expect(sent).toEqual([]);
    expect(
      first.container.querySelector<HTMLTextAreaElement>(
        '[data-testid="scratch-message-composer"]',
      )?.value,
    ).toBe("draft only");
  });
  function sendButton(container: HTMLDivElement): HTMLButtonElement {
    return container.querySelector<HTMLButtonElement>(
      '[data-testid="scratch-composer-send"]',
    ) as HTMLButtonElement;
  }

  it("keeps Send usable while the turn-starting request is still pending", async () => {
    const sent: string[] = [];
    const busy = mountBusy({
      status: "Running",
      pending: true,
      onSend: async (payload) => {
        sent.push(payload.content);

        return true;
      },
      onInterrupt: async () => true,
    });
    const textarea = busy.container.querySelector<HTMLTextAreaElement>(
      '[data-testid="scratch-message-composer"]',
    ) as HTMLTextAreaElement;

    setTextarea(textarea, "steer this");
    expect(sendButton(busy.container).disabled).toBe(false);
    expect(sendButton(busy.container).textContent).toBe("scratch.send");
    act(() => sendButton(busy.container).click());
    await flush();
    expect(sent).toEqual(["steer this"]);

    setTextarea(textarea, "and this");
    act(() => {
      textarea.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          metaKey: true,
          bubbles: true,
        }),
      );
    });
    await flush();
    expect(sent).toEqual(["steer this", "and this"]);
  });

  it("does not offer Send while the dialog is Starting — there is no session to steer or queue for yet", async () => {
    const sent: string[] = [];
    const starting = mountBusy({
      status: "Starting",
      onSend: async (payload) => {
        sent.push(payload.content);

        return true;
      },
      onInterrupt: async () => true,
    });
    const textarea = starting.container.querySelector<HTMLTextAreaElement>(
      '[data-testid="scratch-message-composer"]',
    ) as HTMLTextAreaElement;

    setTextarea(textarea, "too early");
    expect(sendButton(starting.container)).toBeNull();
    expect(
      starting.container.querySelector('[data-testid="scratch-composer-stop"]'),
    ).not.toBeNull();
    act(() => {
      textarea.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          ctrlKey: true,
          bubbles: true,
        }),
      );
    });
    await flush();
    expect(sent).toEqual([]);
  });
});
