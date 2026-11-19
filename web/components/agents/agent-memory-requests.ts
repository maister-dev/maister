import type { VaultConflict } from "@/lib/agent-memory-vault/store";
import type { viewAgentMemory } from "@/lib/agent-memory-vault/view";
import type {
  vaultHistory,
  vaultRevisionDetail,
} from "@/lib/agent-memory-vault/history";

export const memoryRoot = "/memories";
export type View = Awaited<ReturnType<typeof viewAgentMemory>>;
export type Directory = Extract<View, { kind: "directory" }>;
export type History = Awaited<ReturnType<typeof vaultHistory>>;
export type RevisionDetail = Awaited<ReturnType<typeof vaultRevisionDetail>>;
export type Issue = Readonly<{
  code: string;
  status: number;
  current?: VaultConflict["current"];
}>;
export type Draft = Readonly<{
  action: "create" | "edit" | "rename" | "delete" | "clear" | "revert";
  destination: string;
  text: string;
  requestKey: string;
  selection: View;
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
    const issue = body as { code?: string; current?: VaultConflict["current"] };

    throw new VaultRequestError({
      code: issue.code ?? "CRASH",
      status: response.status,
      current: issue.current,
    });
  }

  return body as T;
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

    do {
      const page: View = await vaultRequest(
        noteQuery(base, next, cursor ?? undefined),
      );

      if (page.kind !== "directory" || page.generation !== generation)
        throw new VaultRequestError({ code: "CONFLICT", status: 409 });
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
