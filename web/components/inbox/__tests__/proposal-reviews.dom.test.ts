// @vitest-environment jsdom

import type { ComponentProps } from "react";
import type { Root } from "react-dom/client";

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { ProposalReviews } from "@/components/inbox/proposal-reviews";

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));
const translate = (key: string): string => key;

vi.mock("next-intl", () => ({ useTranslations: () => translate }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

const first = {
  kind: "vault",
  id: "proposal-1",
  version: "1",
  title: "First proposal",
  allowed: ["accept"],
  createdAt: "2026-11-20T09:00:00Z",
} satisfies ComponentProps<typeof ProposalReviews>["page"]["items"][number];
const second = { ...first, id: "proposal-2", title: "Second proposal" };

let container: HTMLDivElement;
let root: Root;

function render(
  items: ComponentProps<typeof ProposalReviews>["page"]["items"],
) {
  act(() => {
    root.render(
      createElement(ProposalReviews, {
        page: { items, nextCursor: null },
        filters: {},
      }),
    );
  });
}

async function click(label: string): Promise<void> {
  const button = [...container.querySelectorAll("button")].find(
    (element) => element.textContent === label,
  );

  if (!button) throw new Error(`Missing button ${label}`);
  await act(async () => button.click());
}

beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  refresh.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("replays the same batch after partial settlement removes a selected row and the response is lost", async () => {
  const fetcher = vi
    .fn<(url: string, options: RequestInit) => Promise<Response>>()
    .mockRejectedValueOnce(new TypeError("Response lost"))
    .mockResolvedValueOnce(
      Response.json({
        results: [
          { status: "applied", replayed: true, receiptId: "receipt-1" },
          { status: "applied", replayed: false, receiptId: "receipt-2" },
        ],
      }),
    );

  vi.stubGlobal("fetch", fetcher);
  render([first, second]);
  await act(async () => {
    for (const box of container.querySelectorAll<HTMLInputElement>(
      'input[type="checkbox"]',
    ))
      box.click();
  });
  await click("accept");
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    "refused",
  );
  const sent = fetcher.mock.calls[0]!;

  expect(JSON.parse(String(sent[1].body))).toEqual({
    items: [
      {
        kind: first.kind,
        id: first.id,
        expectedVersion: first.version,
        decision: "accept",
        requestKey: expect.any(String),
      },
      {
        kind: second.kind,
        id: second.id,
        expectedVersion: second.version,
        decision: "accept",
        requestKey: expect.any(String),
      },
    ],
  });

  render([second]);
  expect(
    container.querySelector<HTMLInputElement>('input[type="checkbox"]')
      ?.disabled,
  ).toBe(true);
  await click("retry");

  expect(fetcher.mock.calls).toEqual([sent, sent]);
  expect(container.querySelector('[aria-label="results"]')?.textContent).toBe(
    "First proposal · outcome.appliedSecond proposal · outcome.applied",
  );
  expect(refresh).toHaveBeenCalledOnce();
});
