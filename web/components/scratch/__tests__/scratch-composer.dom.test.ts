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
    testId?: string;
    value: string;
  }) =>
    createElement("textarea", {
      "data-testid": props.testId,
      value: props.value,
      onChange: (event: { currentTarget: { value: string } }) =>
        props.onChange(event.currentTarget.value),
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
  function mountBusy(props: {
    status: "Running" | "WaitingForUser";
    onSend: (payload: { content: string }) => Promise<boolean>;
    onInterrupt: () => Promise<boolean>;
  }): {
    container: HTMLDivElement;
    rerender: (status: "Running" | "WaitingForUser") => void;
  } {
    const container = document.createElement("div");
    const root = createRoot(container);
    const render = (status: "Running" | "WaitingForUser"): void => {
      act(() => {
        root.render(
          createElement(ScratchComposer, {
            status,
            pending: false,
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

  it("a reload during Running loses nothing — Stop no longer arms an auto-send", async () => {
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
});
