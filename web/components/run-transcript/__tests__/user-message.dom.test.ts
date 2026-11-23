// @vitest-environment jsdom

import type { Root } from "react-dom/client";
import type { TranscriptMessage } from "../transcript-view";

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { UserMessage } from "../user-message";
import en from "@/messages/en.json";
import ru from "@/messages/ru.json";

const labels = {
  thinking: "Thinking",
  rawEvent: "Raw",
  input: "Input",
  result: "Result",
  copy: "Copy",
  copied: "Copied",
  toolCount: (name: string, count: number) => `${name} ${count}`,
};
let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  window.history.replaceState({ retained: true }, "", "/run?tab=trace#anchor");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
async function render(
  messages: readonly TranscriptMessage[],
  locale = "en",
): Promise<void> {
  await act(async () =>
    root.render(
      createElement(NextIntlClientProvider, {
        locale,
        messages: locale === "en" ? en : ru,
        timeZone: "UTC",
        // eslint-disable-next-line react-jsx/no-children-prop -- Non-JSX renderer.
        children: messages.map((message) =>
          createElement(UserMessage, {
            key: message.id + message.content,
            message,
            labels,
            repeated: false,
            attachments: null,
          }),
        ),
      }),
    ),
  );
}
function message(id = "a", bounded = false): TranscriptMessage {
  return {
    id,
    role: "user",
    content: "Retained prompt ".repeat(200),
    createdAt: "",
    ...(bounded
      ? { preview: { originalBytes: 900_000, fullContentHref: "/full" } }
      : {}),
  };
}
async function click(element: Element): Promise<void> {
  await act(async () => (element as HTMLElement).click());
}

it("synchronizes independent scopes, nested disclosure, URL restoration and history state without writes on restoration", async () => {
  const source = message();
  source.content +=
    "\n## Packaged skills\nWhen the task or agent instructions require a packaged skill, read its SKILL.md using the workspace-relative path below. Use this copy for the packaged instructions and resolve its companion files relative to SKILL.md.\n- a: `workspace/a/SKILL.md`";
  await render([source, message("b")]);
  await click(host.querySelector("summary")!);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
  await click(host.querySelectorAll("summary")[1]);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
  expect(
    new URLSearchParams(window.location.search).getAll("transcript-open"),
  ).toHaveLength(2);
  await click(host.querySelectorAll("summary")[2]);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
  expect(
    new URLSearchParams(window.location.search).getAll("transcript-open"),
  ).toHaveLength(3);
  expect(window.history.state).toEqual({ retained: true });
  expect(window.location.hash).toBe("#anchor");
  expect(new URLSearchParams(window.location.search).get("tab")).toBe("trace");
  const saved = window.location.href;

  await act(async () => {
    window.history.replaceState(window.history.state, "", "/run?tab=other");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  const replace = vi.spyOn(window.history, "replaceState");

  await act(async () => {
    window.history.replaceState(window.history.state, "", saved);
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  expect(host.querySelectorAll("details[open]")).toHaveLength(3);
  expect(replace).toHaveBeenCalledTimes(1);
});

it("restored bounded rows wait for explicit intent, share one load and copy full original text", async () => {
  window.history.replaceState(
    {},
    "",
    "/run?transcript-open=" +
      encodeURIComponent(JSON.stringify([1, "a", "message"])),
  );
  let release: (response: Response) => void = () => {};
  const fetcher = vi.fn(
    () =>
      new Promise<Response>((resolve) => {
        release = resolve;
      }),
  );
  const copied: string[] = [];

  vi.stubGlobal("fetch", fetcher);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: async (text: string) => {
        copied.push(text);
      },
    },
  });
  await render([message("a", true)]);
  expect(fetcher).not.toHaveBeenCalled();
  const buttons = host.querySelectorAll("button");

  await click(buttons[1]);
  await click(buttons[0]);
  expect(fetcher).toHaveBeenCalledTimes(1);
  await act(async () => release(new Response("Full original\r\ntext")));
  expect(copied).toEqual(["Full original\r\ntext"]);
  expect(host.textContent).toContain("Full original");
});

it("retries transient body-read failures and fails immediately on authorization denial", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce({
      ok: true,
      text: async () => {
        throw new TypeError("connection reset");
      },
    })
    .mockResolvedValueOnce(new Response("Original"));

  vi.stubGlobal("fetch", fetcher);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: async () => {} },
  });
  await render([message("a", true)]);
  await click(host.querySelector("button")!);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(host.querySelector('[role="alert"]')).toBeNull();
  await render([message("b", true)]);
  fetcher
    .mockReset()
    .mockResolvedValue(new Response("Denied", { status: 403 }));
  await click(host.querySelector("button")!);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(
    "Could not load",
  );
});

it("reports unavailable/rejected clipboard in Russian and permits retry", async () => {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: undefined,
  });
  await render([message()], "ru");
  await click(host.querySelector("button")!);
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(
    "Не удалось скопировать",
  );
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: async () => {
        throw new DOMException("denied");
      },
    },
  });
  await click(host.querySelector("button")!);
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(
    "Не удалось скопировать",
  );
  const write = vi.fn().mockResolvedValue(undefined);

  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: write },
  });
  await click(host.querySelector("button")!);
  expect(write).toHaveBeenCalledWith(message().content);
  expect(host.querySelector('[role="alert"]')).toBeNull();
});

it("aborts stale loads without copying or publishing the old result", async () => {
  let release: (response: Response) => void = () => {};
  let signal: AbortSignal | undefined;
  const write = vi.fn().mockResolvedValue(undefined);

  vi.stubGlobal("fetch", (_href: URL, options: RequestInit) => {
    signal = options.signal as AbortSignal;

    return new Promise<Response>((resolve) => {
      release = resolve;
    });
  });
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: write },
  });
  await render([message("a", true)]);
  await click(host.querySelector("button")!);
  await render([message("b")]);
  expect(signal?.aborted).toBe(true);
  await act(async () => release(new Response("Stale content")));
  expect(write).not.toHaveBeenCalled();
  expect(host.textContent).not.toContain("Stale content");
});
