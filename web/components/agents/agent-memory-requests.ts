import type { VaultConflict } from "@/lib/agent-memory-vault/store";
import type { viewAgentMemory } from "@/lib/agent-memory-vault/view";
import type {
  vaultHistory,
  vaultRevisionDetail,
} from "@/lib/agent-memory-vault/history";

import { truncateUtf16 } from "@/lib/utf16";

export const memoryRoot = "/memories";
export type View = Awaited<ReturnType<typeof viewAgentMemory>>;
export type Directory = Extract<View, { kind: "directory" }>;
export type History = Awaited<ReturnType<typeof vaultHistory>>;
export type RevisionDetail = Awaited<ReturnType<typeof vaultRevisionDetail>>;
export type Issue = Readonly<{
  code: string;
  status: number;
  reason?: string;
  current?: VaultConflict["current"];
}>;
export type Draft = Readonly<{
  action: "create" | "edit" | "rename" | "delete" | "clear" | "revert";
  destination: string;
  text: string;
  requestKey: string;
  selection:
    | View
    | Readonly<{
        kind: "note";
        noteId: string;
        path: string;
        revisionId: string;
        hash: null;
      }>;
  revisionId?: string;
}>;

export class VaultRequestError extends Error {
  constructor(readonly issue: Issue) {
    super(issue.code);
  }
}

export function displayIssue(error: unknown): Issue {
  return error instanceof VaultRequestError
    ? error.issue
    : { code: "CRASH", status: 500 };
}

export async function vaultRequest<T>(
  url: string,
  options?: RequestInit,
): Promise<T> {
  const response = await fetch(url, { ...options, cache: "no-store" });
  const body: unknown = await response.json();

  if (!response.ok) {
    const issue = body as {
      code?: string;
      current?: VaultConflict["current"];
      details?: { reason?: string };
    };

    throw new VaultRequestError({
      code: issue.code ?? "CRASH",
      status: response.status,
      reason: issue.details?.reason,
      current: issue.current,
    });
  }

  return body as T;
}

const comparisonUnits = 32_768;

export async function compareVaultRevision(
  api: string,
  first: Extract<View, { kind: "note" }>,
  historicalContent: string,
  historicalHash: string | null,
  signal: AbortSignal,
) {
  let current = first.content;
  let cursor = first.nextCursor;

  while (cursor && current.length < comparisonUnits) {
    const params = new URLSearchParams({ noteId: first.noteId, cursor });
    const page = await vaultRequest<View>(`${api}/notes?${params}`, { signal });

    if (
      page.kind !== "note" ||
      page.noteId !== first.noteId ||
      page.revisionId !== first.revisionId ||
      page.hash !== first.hash
    )
      throw new VaultRequestError({ code: "CONFLICT", status: 409 });
    current += page.content;
    cursor = page.nextCursor;
  }

  const previousPrefix = truncateUtf16(historicalContent, comparisonUnits);
  const currentPrefix = truncateUtf16(current, comparisonUnits);
  const status =
    historicalHash === first.hash
      ? "comparisonIdentical"
      : previousPrefix === currentPrefix
        ? "comparisonDifferentAfterPreview"
        : "comparisonDifferent";

  return {
    previousPrefix,
    currentPrefix,
    status,
    truncated:
      cursor !== null ||
      currentPrefix.length < current.length ||
      previousPrefix.length < historicalContent.length,
  } as const;
}

export function noteQuery(base: string, path: string, cursor?: string): string {
  const params = new URLSearchParams({ path });

  if (cursor) params.set("cursor", cursor);

  return `${base}/notes?${params}`;
}

export function parentPath(path: string) {
  return path === memoryRoot
    ? memoryRoot
    : path.slice(0, path.lastIndexOf("/"));
}

async function manifest(base: string, path: string, generation: string) {
  const pending = [path];
  const heads: { path: string; ifHash: string; ifRevisionId: string }[] = [];

  while (pending.length > 0) {
    const next = pending.pop()!;
    let cursor: string | null = null;
    // Installation generations describe the visible heads of each subtree.
    let directoryGeneration = next === path ? generation : undefined;

    do {
      const page: View = await vaultRequest(
        noteQuery(base, next, cursor ?? undefined),
      );

      if (
        page.kind !== "directory" ||
        (directoryGeneration !== undefined &&
          page.generation !== directoryGeneration)
      )
        throw new VaultRequestError({ code: "CONFLICT", status: 409 });
      directoryGeneration = page.generation;
      for (const entry of page.entries) {
        if (entry.kind === "directory") pending.push(entry.path);
        else if (entry.hash && entry.revisionId)
          heads.push({
            path: entry.path,
            ifHash: entry.hash,
            ifRevisionId: entry.revisionId,
          });
      }
      cursor = page.nextCursor;
    } while (cursor !== null);
  }

  return { ifGeneration: generation, heads };
}

export async function buildVaultCommand(base: string, draft: Draft) {
  const { action, text, destination, requestKey, selection } = draft;
  const path = selection.path;

  if (action === "create")
    return {
      command: "create",
      path: destination,
      file_text: text,
      ifHash: null,
      ifRevisionId: null,
      requestKey,
    };
  if (selection.kind === "note") {
    const before = {
      ifHash: selection.hash,
      ifRevisionId: selection.revisionId,
      requestKey,
    };

    switch (action) {
      case "edit":
        return { command: "create", path, file_text: text, ...before };
      case "rename":
        return {
          command: "rename",
          old_path: path,
          new_path: destination,
          ...before,
        };
      case "delete":
        return { command: "delete", path, ...before };
      case "revert":
        return {
          command: "revert",
          noteId: selection.noteId,
          revisionId: draft.revisionId,
          ...before,
        };
    }
  } else {
    const before = {
      ...(await manifest(
        base,
        action === "clear" ? memoryRoot : path,
        selection.generation,
      )),
      requestKey,
    };

    switch (action) {
      case "clear":
        return { command: "clear", ...before };
      case "rename":
        return {
          command: "rename",
          old_path: path,
          new_path: destination,
          ...before,
        };
      case "delete":
        return { command: "delete", path, ...before };
    }
  }
  throw new VaultRequestError({ code: "CONFIG", status: 422 });
}
