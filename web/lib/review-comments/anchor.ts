// Pure anchor extraction + placement matching for review comments (ADR-072,
// docs/system-analytics/review-comments.md). Operates primarily on the pure
// unified-diff line index (`DiffLineIndex` from `parseDiffLineIndex`, zero
// Shiki WASM) and also accepts `DiffPrepResult` for backward compatibility,
// keying every lookup by the per-side 1-based file line number — the exact
// (lineNumber, SplitSide) the diff widget emits.

import type { DiffLineIndex } from "@/lib/diff/line-index";
import type { DiffPrepResult, PreparedFile } from "@/lib/diff/prepare";

export type AnchorDiffSource = DiffLineIndex | DiffPrepResult;

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

type BundleDiffLine = PreparedFile["bundle"]["oldFileDiffLines"][string];

type LineLookup =
  | { found: true; content: string }
  | { found: false; reason: "file_absent" | "line_absent" };

// The @git-diff-view/core parser keeps each data line's trailing LF (absent
// only at the physical end of the diff text); `line_content` is the line as
// displayed — strip exactly that one LF, preserving every other byte (CR,
// trailing spaces).
function stripTrailingNewline(text: string): string {
  return text.endsWith("\n") ? text.slice(0, -1) : text;
}

function lookupLine(
  source: AnchorDiffSource,
  position: AnchorPosition,
): LineLookup {
  if (!("perFile" in source)) {
    const file = source.files.get(position.filePath);

    if (!file) return { found: false, reason: "file_absent" };

    const bySide = position.side === "old" ? file.oldLines : file.newLines;
    const content = bySide.get(position.line);

    if (content === undefined) {
      return { found: false, reason: "line_absent" };
    }

    return { found: true, content };
  }

  const file = source.perFile.find((f) => f.path === position.filePath);

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
