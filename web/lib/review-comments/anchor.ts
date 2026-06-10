// Pure anchor extraction + placement matching for review comments (ADR-071,
// docs/system-analytics/review-comments.md). Operates on the SAME prepared
// diff the view renders (`prepareDiff` bundles hydrate the client `DiffFile`),
// so an anchor always points at what the reviewer actually saw: the bundle's
// `oldFileDiffLines`/`newFileDiffLines` are keyed by the per-side 1-based file
// line number — the exact (lineNumber, SplitSide) the diff widget emits.

import type { DiffPrepResult, PreparedFile } from "@/lib/diff/prepare";

export type AnchorSide = "old" | "new";

export type AnchorPosition = {
  filePath: string;
  side: AnchorSide;
  line: number;
};

export type StoredAnchor = AnchorPosition & { lineContent: string };

export type ExtractFailureReason =
  | "diff_truncated"
  | "file_absent"
  | "line_absent";

export type AnchorExtraction =
  | { ok: true; lineContent: string }
  | { ok: false; reason: ExtractFailureReason };

export type Placement = "inline" | "outdated";

type BundleDiffLine = PreparedFile["bundle"]["oldFileDiffLines"][string];

type LineLookup =
  | { found: true; content: string }
  | { found: false; reason: "file_absent" | "line_absent" };

// The diff parser keeps each data line's trailing LF (absent only at the
// physical end of the diff text); `line_content` is the line as displayed —
// strip exactly that one LF, preserving every other byte (CR, trailing spaces).
function stripTrailingNewline(text: string): string {
  return text.endsWith("\n") ? text.slice(0, -1) : text;
}

function lookupLine(
  prepared: DiffPrepResult,
  position: AnchorPosition,
): LineLookup {
  const file = prepared.perFile.find((f) => f.path === position.filePath);

  if (!file) return { found: false, reason: "file_absent" };

  const bySide =
    position.side === "old"
      ? file.bundle.oldFileDiffLines
      : file.bundle.newFileDiffLines;
  const item: BundleDiffLine | undefined = bySide[position.line];

  if (!item) return { found: false, reason: "line_absent" };

  return { found: true, content: stripTrailingNewline(item.text) };
}

export function extractAnchorContent(
  prepared: DiffPrepResult,
  position: AnchorPosition,
): AnchorExtraction {
  // POST-time rule (ADR-071): anchors cannot be validated against a partial
  // diff — refuse even when the position survives in the truncated prefix.
  if (prepared.truncated) return { ok: false, reason: "diff_truncated" };

  const hit = lookupLine(prepared, position);

  if (!hit.found) return { ok: false, reason: hit.reason };

  return { ok: true, lineContent: hit.content };
}

export function computePlacement(
  prepared: DiffPrepResult,
  anchor: StoredAnchor,
): Placement {
  // GET-time, unlike extraction, ignores `truncated`: threads match against
  // the surviving prefix; a file past the bound is simply absent -> outdated.
  const hit = lookupLine(prepared, anchor);

  return hit.found && hit.content === anchor.lineContent
    ? "inline"
    : "outdated";
}
