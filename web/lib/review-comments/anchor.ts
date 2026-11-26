// Pure anchor extraction + placement matching for review comments (ADR-072,
// docs/system-analytics/review-comments.md). Operates on the pure unified-diff
// line index (`DiffLineIndex` from `parseDiffLineIndex`, zero Shiki WASM),
// keying every lookup by the per-side 1-based file line number — the exact
// (lineNumber, SplitSide) the diff widget emits.

import type { DiffLineIndex } from "@/lib/diff/line-index";

export type AnchorDiffSource = DiffLineIndex;

export type AnchorSide = "old" | "new";

export type AnchorPosition = {
  filePath: string;
  side: AnchorSide;
  line: number;
};

export type StoredAnchor = AnchorPosition & { lineContent: string };

export type ExtractFailureReason =
  "diff_truncated" | "file_absent" | "line_absent";

export type AnchorExtraction =
  | { ok: true; lineContent: string }
  | { ok: false; reason: ExtractFailureReason };

export type Placement = "inline" | "outdated";

type LineLookup =
  | { found: true; content: string }
  | { found: false; reason: "file_absent" | "line_absent" };

function lookupLine(
  source: AnchorDiffSource,
  position: AnchorPosition,
): LineLookup {
  const file = source.files.get(position.filePath);

  if (!file) return { found: false, reason: "file_absent" };

  const bySide = position.side === "old" ? file.oldLines : file.newLines;
  const content = bySide.get(position.line);

  if (content === undefined) {
    return { found: false, reason: "line_absent" };
  }

  return { found: true, content };
}

export function extractAnchorContent(
  source: AnchorDiffSource,
  position: AnchorPosition,
): AnchorExtraction {
  // POST-time rule (ADR-072): anchors cannot be validated against a partial
  // diff — refuse even when the position survives in the truncated prefix.
  if (source.truncated) return { ok: false, reason: "diff_truncated" };

  const hit = lookupLine(source, position);

  if (!hit.found) return { ok: false, reason: hit.reason };

  return { ok: true, lineContent: hit.content };
}

export function computePlacement(
  source: AnchorDiffSource,
  anchor: StoredAnchor,
): Placement {
  // GET-time, unlike extraction, ignores `truncated`: threads match against
  // the surviving prefix; a file past the bound is simply absent -> outdated.
  const hit = lookupLine(source, anchor);

  return hit.found && hit.content === anchor.lineContent
    ? "inline"
    : "outdated";
}
