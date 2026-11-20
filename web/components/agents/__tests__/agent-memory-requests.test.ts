import type {
  Directory,
  Draft,
} from "@/components/agents/agent-memory-requests";

import { afterEach, expect, it, vi } from "vitest";

import {
  buildVaultCommand,
  memoryRoot,
} from "@/components/agents/agent-memory-requests";

const base = "/api/specialists/library/bindings/installation/memory";
const folder = `${memoryRoot}/projects`;
const nested = `${folder}/2026`;
const requestKey = "installation-tree";

function note(path: string, revisionId: string): Directory["entries"][number] {
  return { path, kind: "note", noteId: path, revisionId, hash: "a".repeat(64) };
}

function directory(path: string): Directory["entries"][number] {
  return {
    path,
    kind: "directory",
    noteId: null,
    revisionId: null,
    hash: null,
  };
}

const index = note(`${memoryRoot}/index.md`, "revision-1");
const overview = note(`${folder}/overview.md`, "revision-2");
const plan = note(`${nested}/plan.md`, "revision-3");
const status = note(`${nested}/status.md`, "revision-4");

const rootView: Directory = {
  kind: "directory",
  path: memoryRoot,
  generation: "100",
  entries: [index, directory(folder)],
  nextCursor: null,
};
const folderView: Directory = {
  kind: "directory",
  path: folder,
  generation: "101",
  entries: [overview, directory(nested)],
  nextCursor: null,
};
const nestedView: Directory = {
  kind: "directory",
  path: nested,
  generation: "102",
  entries: [plan],
  nextCursor: "second-page",
};
const nestedLastView: Directory = {
  ...nestedView,
  entries: [status],
  nextCursor: null,
};

function setupTree({
  root = rootView,
  nestedLast = nestedLastView,
}: {
  root?: Directory;
  nestedLast?: Directory;
} = {}): void {
  const pages = new Map([
    [memoryRoot, root],
    [folder, folderView],
    [nested, nestedView],
    [`${nested}?second-page`, nestedLast],
  ]);

  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const query = new URL(url, "http://localhost").searchParams;
      const key =
        query.get("path") +
        (query.has("cursor") ? `?${query.get("cursor")}` : "");
      const page = pages.get(key);

      if (!page) throw new Error(`Unexpected directory request ${key}`);

      return Response.json(page);
    }),
  );
}

function manifestHeads(entries: readonly Directory["entries"][number][]) {
  return entries.map(({ path, hash, revisionId }) => ({
    path,
    ifHash: hash,
    ifRevisionId: revisionId,
  }));
}

afterEach(() => vi.unstubAllGlobals());

it.each([
  ["clear", rootView, [index, overview, plan, status], {}],
  ["delete", folderView, [overview, plan, status], { path: folder }],
  [
    "rename",
    folderView,
    [overview, plan, status],
    { old_path: folder, new_path: `${memoryRoot}/archive` },
  ],
] as const)(
  "collects a nested installation %s against the selected directory generation",
  async (action, selection, heads, target) => {
    setupTree();

    await expect(
      buildVaultCommand(base, {
        action,
        selection,
        destination: `${memoryRoot}/archive`,
        text: "",
        requestKey,
      }),
    ).resolves.toEqual({
      command: action,
      ...target,
      ifGeneration: selection.generation,
      heads: manifestHeads(heads),
      requestKey,
    });
  },
);

it.each([
  ["selected root", { root: { ...rootView, generation: "101" } }],
  [
    "paged descendant",
    { nestedLast: { ...nestedLastView, generation: "103" } },
  ],
] as const)("refuses a changed %s snapshot", async (_scope, pages) => {
  setupTree(pages);
  const draft: Draft = {
    action: "clear",
    selection: rootView,
    destination: "",
    text: "",
    requestKey,
  };

  await expect(buildVaultCommand(base, draft)).rejects.toMatchObject({
    issue: { code: "CONFLICT", status: 409 },
  });
});
