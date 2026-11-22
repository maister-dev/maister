// @vitest-environment jsdom

import type { ComponentProps } from "react";
import type { Root } from "react-dom/client";

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { ProposalReviews } from "@/components/inbox/proposal-reviews";

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));
const translate = (key: string): string => key;

vi.mock("next-intl", () => ({
  useTranslations: () => translate,
  useFormatter: () => ({ dateTime: (date: Date) => date.toISOString() }),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

const first = {
  kind: "vault",
  id: "proposal-1",
  version: "1",
  title: "First proposal",
  allowed: ["accept"],
  createdAt: "2026-11-20T09:00:00Z",
  owner: { kind: "project", id: "fixture", label: "Fixture" },
  agentId: null,
  author: null,
  domainState: "pending",
  outcomeAvailable: false,
} satisfies ComponentProps<typeof ProposalReviews>["page"]["items"][number];
const second = { ...first, id: "proposal-2", title: "Second proposal" };

let container: HTMLDivElement;
let root: Root;

function render(
  items: ComponentProps<typeof ProposalReviews>["page"]["items"],
  initial?: ComponentProps<typeof ProposalReviews>["initial"],
  workspace?: boolean,
) {
  act(() => {
    root.render(
      createElement(ProposalReviews, {
        page: { items, nextCursor: null, total: items.length },
        filters: {},
        initial,
        workspace,
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

it("K03 settles a deep-linked proposal outside the current page without selecting a batch row", async () => {
  const decision = {
    kind: "vault",
    id: second.id,
    reviewedVersion: second.version,
    domainState: "accepted",
    outcome: {
      type: "applied_vault_operation",
      operationId: "operation-2",
      href: null,
    },
    receiptId: "receipt-2",
    replayed: false,
  };
  const fetcher = vi
    .fn<(url: string, options: RequestInit) => Promise<Response>>()
    .mockResolvedValueOnce(
      Response.json({
        ...second,
        summary: "Exact off-page diff",
        detail: {
          operationId: "proposal-operation",
          changeCount: 1,
          vaultHref: null,
        },
        decision: { by: null, at: null, reason: null, reviewedVersion: null },
        nextCursor: null,
        outcome: null,
      }),
    )
    .mockResolvedValueOnce(Response.json(decision))
    .mockResolvedValueOnce(
      Response.json({
        ...second,
        summary: "Exact off-page diff",
        detail: {
          operationId: "proposal-operation",
          changeCount: 1,
          vaultHref: null,
        },
        decision: {
          by: "fixture",
          at: "2026-11-20T09:00:00Z",
          reason: null,
          reviewedVersion: "1",
        },
        allowed: [],
        domainState: "accepted",
        nextCursor: null,
        outcome: decision.outcome,
      }),
    );

  vi.stubGlobal("fetch", fetcher);
  await act(async () => render([first], { kind: second.kind, id: second.id }));
  const accept = [
    ...document.querySelectorAll<HTMLButtonElement>("button"),
  ].find((button) => button.textContent === "acceptReviewed");

  expect(accept?.disabled).toBe(false);
  await act(async () => accept?.click());
  const [url, options] = fetcher.mock.calls[1]!;

  expect(url).toBe("/api/inbox/reviews/vault/proposal-2/decision");
  expect(JSON.parse(String(options.body))).toEqual({
    expectedVersion: "1",
    decision: "accept",
    requestKey: expect.any(String),
  });
  expect(document.body.textContent).toContain(
    "outcomeLabel.applied_vault_operation",
  );
});

it("K03 preserves the selected review boundary and shows the retained decision after the queue moves", async () => {
  const latest = {
    ...first,
    id: "proposal-4",
    createdAt: "2026-11-20T09:00:03.000000Z",
  };
  const reviewed = {
    ...first,
    id: "proposal-3",
    title: "Reviewed proposal",
    createdAt: "2026-11-20T09:00:02.000000Z",
    author: "note-author",
    domainState: "accepted",
    allowed: [],
    outcomeAvailable: true,
  };
  const reviewTime = "2026-11-20T10:00:00Z";
  const fetcher = vi.fn().mockResolvedValue(
    Response.json({
      ...reviewed,
      summary: "Exact reviewed diff",
      sourceRevisionId: "source-revision",
      detail: {
        operationId: "reviewed-operation",
        changeCount: 1,
        vaultHref: null,
      },
      decision: {
        by: "retained-reviewer",
        at: reviewTime,
        reason: "Checked the note",
        reviewedVersion: "1",
      },
      nextCursor: null,
      outcome: {
        type: "applied_vault_operation",
        operationId: "operation",
        href: null,
      },
    }),
  );

  vi.stubGlobal("fetch", fetcher);
  await act(async () =>
    render([latest, first], { kind: reviewed.kind, id: reviewed.id }, true),
  );

  const next = [...container.querySelectorAll("a")].find(
    (link) => link.textContent === "nextReview",
  );

  expect
    .soft(new URL(next!.href).searchParams.get("proposalId"))
    .toBe(first.id);
  expect.soft(container.textContent).toContain("note-author");
  expect.soft(container.textContent).toContain("source-revision");
  expect.soft(container.textContent).toContain("retained-reviewer");
  expect(container.querySelector("time")?.dateTime).toBe(reviewTime);
});

it("K10 keeps the current proposal preview page when paging applied revisions", async () => {
  const settled = {
    ...first,
    allowed: [],
    domainState: "accepted",
    summary: "Reviewed diff",
    sourceRevisionId: null,
    detail: {
      operationId: "reviewed-operation",
      changeCount: 21,
      vaultHref: null,
    },
    decision: { by: null, at: null, reason: null, reviewedVersion: "1" },
  };
  const fetcher = vi.fn<
    (url: string, options: RequestInit) => Promise<Response>
  >(async (url) => {
    const params = new URL(url, "http://localhost").searchParams;
    const outcomeContinued = params.has("outcomeCursor");

    return Response.json({
      ...settled,
      nextCursor: params.has("cursor") ? null : "preview-next",
      outcome: {
        type: "applied_vault_operation",
        operationId: "applied-operation",
        href: null,
        revisionCount: 21,
        revisions: [
          {
            path: outcomeContinued ? "/memories/last.md" : "/memories/first.md",
            href: null,
            revisionId: outcomeContinued ? "last" : "first",
          },
        ],
        revisionsNextCursor: outcomeContinued ? null : "outcome-next",
      },
    });
  });

  vi.stubGlobal("fetch", fetcher);
  await act(async () => render([], { kind: first.kind, id: first.id }, true));
  await click("previewNext");
  await click("resultNext");

  expect(fetcher).toHaveBeenLastCalledWith(
    "/api/inbox/reviews/vault/proposal-1?cursor=preview-next&outcomeCursor=outcome-next",
    expect.objectContaining({ cache: "no-store" }),
  );
  expect(container.textContent).toContain("/memories/last.md");
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
