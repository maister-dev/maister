// @vitest-environment jsdom

import type { Directory } from "@/components/agents/agent-memory-requests";
import type { Root } from "react-dom/client";

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { AgentMemoryControl } from "@/components/agents/agent-memory-control";

const { replace } = vi.hoisted(() => ({ replace: vi.fn() }));
const translate = (key: string): string => key;
const folder = "/memories/projects";
const nested = `${folder}/archive`;
const search = new URLSearchParams({ memoryPath: folder });

vi.mock("next-intl", () => ({
  useTranslations: () => translate,
  useFormatter: () => ({ dateTime: vi.fn() }),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
  useSearchParams: () => search,
}));

const folderView: Directory = {
  kind: "directory",
  path: folder,
  generation: "100",
  entries: [
    {
      kind: "directory",
      path: nested,
      noteId: null,
      revisionId: null,
      hash: null,
    },
  ],
  nextCursor: null,
};
const nestedView: Directory = {
  kind: "directory",
  path: nested,
  generation: "100",
  entries: [
    {
      kind: "note",
      path: `${nested}/plan.md`,
      noteId: "note-1",
      revisionId: "revision-1",
      hash: "a".repeat(64),
    },
  ],
  nextCursor: null,
};
let root: Root;
let container: HTMLDivElement;

async function render(): Promise<void> {
  await act(async () => {
    root.render(
      createElement(AgentMemoryControl, {
        agentId: "fixture:vault",
        canEdit: true,
        canRedact: false,
        location: {
          kind: "installation",
          companyId: "company-1",
          bindingId: "binding-1",
        },
      }),
    );
  });
}

async function click(label: string): Promise<void> {
  const button = [...document.querySelectorAll("button")].find(
    (element) => element.textContent === label,
  );

  if (!button) throw new Error(`Missing button ${label}`);
  await act(async () => button.click());
}

async function changeDestination(dest: string): Promise<void> {
  const input = document.querySelector<HTMLInputElement>(
    '[role="dialog"] input',
  );

  if (!input) throw new Error("Missing rename destination");
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set?.call(input, dest);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function fakeVault(folderIsGone: (submissions: number) => boolean) {
  const submitted: string[] = [];
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    const request = new URL(url, "http://localhost");

    if (request.pathname.endsWith("/commands")) {
      submitted.push(String(init?.body));
      if (submitted.length === 1) throw new TypeError("Response lost");

      return Response.json({ status: "applied" });
    }
    if (request.pathname.endsWith("/tags"))
      return Response.json({ items: [], nextCursor: null });
    if (request.pathname.endsWith("/notes")) {
      if (folderIsGone(submitted.length))
        return Response.json({ code: "PRECONDITION" }, { status: 404 });

      return Response.json(
        request.searchParams.get("path") === folder ? folderView : nestedView,
      );
    }
    throw new Error(`Unexpected request ${request.pathname}`);
  });

  vi.stubGlobal("fetch", fetcher);

  return submitted;
}

beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  replace.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("replays an unchanged recursive delete after the retained folder disappeared", async () => {
  const submitted = fakeVault((count) => count > 0);

  await render();
  await click("delete");
  await click("save");
  expect(submitted).toHaveLength(1);
  expect(
    document.querySelector('[role="dialog"] [role="alert"]')?.textContent,
  ).toBe("loadError");
  await click("save");

  expect(submitted).toEqual([submitted[0], submitted[0]]);
  expect(replace).toHaveBeenCalledOnce();
});

it("uses a new command and key when the rename draft changes after uncertain delivery", async () => {
  const submitted = fakeVault(() => false);

  await render();
  await click("rename");
  await changeDestination("/memories/new-projects");
  await click("save");
  expect(submitted).toHaveLength(1);

  await changeDestination("/memories/other-projects");
  await click("save");
  expect(submitted).toHaveLength(2);
  const initial = JSON.parse(submitted[0]!);
  const changed = JSON.parse(submitted[1]!);

  expect(initial.new_path).toBe("/memories/new-projects");
  expect(changed.new_path).toBe("/memories/other-projects");
  expect(changed.requestKey).not.toBe(initial.requestKey);
});

it.each([
  ["same content", "old", "old", "", "comparisonIdentical"],
  ["changed on page two", "old", "new", "", "comparisonDifferent"],
  [
    "changed outside the preview",
    "old",
    "old",
    "new tail",
    "comparisonDifferentAfterPreview",
  ],
])(
  "compares the same bounded prefix for long notes: %s",
  async (_case, then, now, tail, status) => {
    const firstPage = "A".repeat(16384);
    const shared = "B".repeat(16381);
    const historical = firstPage + then + shared + "old tail";
    const current = firstPage + now + shared + (tail || "old tail");
    const path = `${folder}/plan.md`;
    const noteId = "note-1";
    const currentId = "current-revision";
    const historicalId = "historical-revision";
    const hash = "a".repeat(64);
    const selection = new URLSearchParams(search);

    search.set("memoryRevision", historicalId);
    search.set("memoryNoteId", noteId);
    search.set("memoryView", "compare");
    if (tail) search.set("memoryCursor", "next");
    vi.stubGlobal("fetch", async (input: string) => {
      const { pathname, searchParams } = new URL(input, "http://localhost");

      if (pathname.endsWith(`/revisions/${historicalId}`))
        return Response.json({
          revision: {
            id: historicalId,
            noteId,
            path,
            state: "available",
            hash,
            createdAt: "2026-11-22T12:00:00Z",
          },
          content: historical,
        });
      if (pathname.endsWith("/notes") && searchParams.has("noteId")) {
        const cursor = searchParams.get("cursor");

        if (cursor && cursor !== "next")
          throw new Error("Read past comparison limit");

        return Response.json({
          kind: "note",
          noteId,
          revisionId: currentId,
          path,
          hash: current === historical ? hash : "b".repeat(64),
          content: cursor ? current.slice(16384, 32768) : firstPage,
          nextCursor: cursor ? "tail" : "next",
        });
      }
      if (pathname.endsWith("/notes")) return Response.json(folderView);
      if (
        ["/tags", "/backlinks", "/revisions"].some((end) =>
          pathname.endsWith(end),
        )
      )
        return Response.json({ items: [], nextCursor: null });
      throw new Error(`Unexpected request ${pathname}`);
    });

    try {
      await render();
      expect(
        container.querySelector('pre[aria-label="history"]')?.textContent,
      ).toBe(historical.slice(0, 32768));
      expect(
        container.querySelector('pre[aria-label="current"]')?.textContent,
      ).toBe(current.slice(0, 32768));
      expect(container.textContent).toContain(status);
      expect(container.textContent).toContain("comparisonLimit");
    } finally {
      for (const key of [...search.keys()]) search.delete(key);
      for (const [key, value] of selection) search.set(key, value);
    }
  },
);
