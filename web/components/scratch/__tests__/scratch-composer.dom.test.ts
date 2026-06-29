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
