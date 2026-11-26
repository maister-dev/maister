import "server-only";

import pino from "pino";

import {
  extractHeaderBodyLines,
  parsePath,
  splitSections,
} from "@/lib/diff/sections";

const log = pino({
  name: "diff-line-index",
  level: process.env.LOG_LEVEL ?? "info",
});

// Unified-diff hunk header: @@ -oldStart[,oldCount] +newStart[,newCount] @@[ heading]
const HUNK_HEADER_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

export type FileLineIndex = {
  path: string;
  oldLines: ReadonlyMap<number, string>;
  newLines: ReadonlyMap<number, string>;
};

export type DiffLineIndex = {
  files: ReadonlyMap<string, FileLineIndex>;
  truncated: boolean;
};

type HunkStart = {
  oldStart: number;
  newStart: number;
};

function parseHunkHeader(line: string): HunkStart | null {
  const match = HUNK_HEADER_RE.exec(line);

  if (!match) return null;

  return {
    oldStart: Number.parseInt(match[1], 10),
    newStart: Number.parseInt(match[2], 10),
  };
}

function indexSectionLines(section: string, path: string): FileLineIndex {
  const oldLines = new Map<number, string>();
  const newLines = new Map<number, string>();
  const headerNl = section.indexOf("\n");

  if (headerNl === -1) {
    return { path, oldLines, newLines };
  }

  let inHeader = true;
  let inHunk = false;
  let oldLine = 0;
  let newLine = 0;
  let pos = headerNl + 1;

  while (pos < section.length) {
    const nl = section.indexOf("\n", pos);
    const lineEnd = nl === -1 ? section.length : nl;
    const line = section.slice(pos, lineEnd);

    if (inHeader) {
      if (
        (line.startsWith("Binary files ") && line.endsWith("differ")) ||
        line === "GIT binary patch"
      ) {
        return { path, oldLines, newLines };
      }

      if (line.startsWith("+++")) {
        inHeader = false;
      }
    } else if (line.startsWith("@@")) {
      const header = parseHunkHeader(line);

      if (header) {
        inHunk = true;
        oldLine = header.oldStart;
        newLine = header.newStart;
      } else {
        log.warn({ path, header: line }, "skipping malformed hunk header");
        inHunk = false;
      }
    } else if (inHunk) {
      if (line.length === 0) {
        // Bare empty line inside a hunk (mirrors @git-diff-view/core issue #41).
        if (oldLine > 0) oldLines.set(oldLine, "");
        if (newLine > 0) newLines.set(newLine, "");
        oldLine += 1;
        newLine += 1;
      } else {
        const prefix = line[0];

        if (prefix === " ") {
          const content = line.slice(1);

          if (oldLine > 0) oldLines.set(oldLine, content);
          if (newLine > 0) newLines.set(newLine, content);
          oldLine += 1;
          newLine += 1;
        } else if (prefix === "+") {
          if (newLine > 0) newLines.set(newLine, line.slice(1));
          newLine += 1;
        } else if (prefix === "-") {
          if (oldLine > 0) oldLines.set(oldLine, line.slice(1));
          oldLine += 1;
        } else if (prefix === "\\") {
          // "\ No newline at end of file" leaves line counters and previous text unchanged.
        } else {
          inHunk = false;
        }
      }
    }

    if (nl === -1) break;
    pos = nl + 1;
  }

  return { path, oldLines, newLines };
}

export function parseDiffLineIndex(
  rawDiff: string,
  truncated = false,
): DiffLineIndex {
  const startedAt = performance.now();
  const sections = splitSections(rawDiff);
  const files = new Map<string, FileLineIndex>();
  let totalLinesIndexed = 0;

  for (const section of sections) {
    const headerNl = section.indexOf("\n");
    const headerLine = headerNl === -1 ? section : section.slice(0, headerNl);
    const bodyLines = extractHeaderBodyLines(section);
    const path = parsePath(headerLine, bodyLines);

    if (files.has(path)) continue;

    const fileIndex = indexSectionLines(section, path);

    files.set(path, fileIndex);
    totalLinesIndexed += fileIndex.oldLines.size + fileIndex.newLines.size;
  }

  const durationMs = Math.round((performance.now() - startedAt) * 100) / 100;

  log.debug(
    {
      fileCount: files.size,
      totalLinesIndexed,
      truncated,
      durationMs,
    },
    "parseDiffLineIndex",
  );

  return { files, truncated };
}
