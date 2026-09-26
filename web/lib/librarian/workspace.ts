import "server-only";

import { mkdir } from "node:fs/promises";
import path from "node:path";

import { runtimeRoot } from "@/lib/runtime-root";

// ADR-183: the reserved runtime slug of every librarian conversation. It is not
// kebab-case, so no registered project slug can ever equal it; the supervisor
// wire schema admits exactly this one literal beside kebab-case slugs.
export const LIBRARIAN_PROJECT_SLUG = "_librarian";

/** The conversation's empty working directory: no repository, no context repos. */
export function librarianWorkspacePath(conversationId: string): string {
  return path.join(
    runtimeRoot(),
    ".maister",
    LIBRARIAN_PROJECT_SLUG,
    conversationId,
  );
}

/** Created by the web before adoption; the supervisor refuses a missing path. */
export async function ensureLibrarianWorkspace(
  conversationId: string,
): Promise<string> {
  const dir = librarianWorkspacePath(conversationId);

  await mkdir(dir, { recursive: true, mode: 0o700 });

  return dir;
}
