// Frozen thread ordering (ADR-071, docs/system-analytics/review-comments.md):
// roots by (file_path asc lexicographic, line asc numeric, side old<new,
// created_at asc, id asc); replies by (created_at asc, id asc). Pure module —
// the single home for the contract, shared by the service layer and the
// rework-payload composer. Structural keys (not the Drizzle row type) keep the
// DB module graph out of pure consumers.

export interface RootOrderKey {
  filePath: string | null;
  line: number | null;
  side: "old" | "new" | null;
  createdAt: Date;
  id: string;
}

export interface ReplyOrderKey {
  createdAt: Date;
  id: string;
}

// Anchor fields are non-null on roots (DB CHECK); the fallbacks (path "",
// line 0, null side bucketed with "new") only keep the comparator total over
// the structural row type.
export function compareThreadRoots(a: RootOrderKey, b: RootOrderKey): number {
  const aPath = a.filePath ?? "";
  const bPath = b.filePath ?? "";

  if (aPath !== bPath) return aPath < bPath ? -1 : 1;

  const lineDiff = (a.line ?? 0) - (b.line ?? 0);

  if (lineDiff !== 0) return lineDiff;

  const sideDiff = (a.side === "old" ? 0 : 1) - (b.side === "old" ? 0 : 1);

  if (sideDiff !== 0) return sideDiff;

  return compareThreadReplies(a, b);
}

export function compareThreadReplies(
  a: ReplyOrderKey,
  b: ReplyOrderKey,
): number {
  const timeDiff = a.createdAt.getTime() - b.createdAt.getTime();

  if (timeDiff !== 0) return timeDiff;
  if (a.id === b.id) return 0;

  return a.id < b.id ? -1 : 1;
}
