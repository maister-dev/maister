import "server-only";

import {
  type DiffAST,
  DiffFile,
  type DiffFileHighlighter,
  getEnableBuildTemplate,
  setEnableBuildTemplate,
} from "@git-diff-view/core";
import pino from "pino";

import { shikiDiffHighlighter } from "@/lib/diff/shiki-adapter";
import { langFromPath, preloadDiffLangs } from "@/lib/highlight/shiki";

const log = pino({
  name: "diff-prepare",
  level: process.env.LOG_LEVEL ?? "info",
});

export const MAX_TOTAL_SYNTAX_LINES = 8_000;
export const DIFF_YIELD_BATCH_SIZE = 5;

export type DiffFileSummary = {
  path: string;
  oldPath?: string;
  status: string;
  additions: number;
  deletions: number;
};

export type PreparedFile = {
  path: string;
  fileLang: string;
  bundle: ReturnType<DiffFile["_getFullBundle"]>;
};

export type DiffPrepResult = {
  files: DiffFileSummary[];
  perFile: PreparedFile[];
  // The producing diff reader cut the output at EXEC_MAX_BUFFER: `files`/`perFile`
  // cover only the bytes that fit. A review/promotion surface MUST block on this
  // rather than treat the prefix as the full change.
  truncated: boolean;
};

const OMITTED_DIFF_BUNDLE_KEYS = new Set([
  "ast",
  "plainTemplate",
  "syntaxTemplate",
  "template",
]);

const EMPTY_HAST_ROOT: DiffAST = { type: "root", children: [] };

// Zero-Shiki fallback used once a diff exceeds MAX_TOTAL_SYNTAX_LINES. Marking
// syntax initialized with an empty `syntaxFile` lets client `DiffFile.initSyntax()`
// early-return without invoking lowlight (ADR-066 FINDING G) so `@git-diff-view/react`
// renders the pre-built `plainFile` lines as monochrome plaintext.
const plaintextDiffHighlighter: DiffFileHighlighter = {
  name: "plaintext",
  type: "class",
  maxLineToIgnoreSyntax: Number.MAX_SAFE_INTEGER,
  setMaxLineToIgnoreSyntax: () => {},
  ignoreSyntaxHighlightList: [],
  setIgnoreSyntaxHighlightList: () => {},
  getAST: () => EMPTY_HAST_ROOT,
  processAST: () => ({ syntaxFileObject: {}, syntaxFileLineNumber: 0 }),
  hasRegisteredCurrentLang: () => true,
};

type ParsedSection = {
  section: string;
  path: string;
  oldPath?: string;
  status: string;
  additions: number;
  deletions: number;
  syntaxLines: number;
};

// A unified diff is concatenated per-file sections, each starting with
// "diff --git a/<old> b/<new>". Mirrors extractFileSection's split regex.
function splitSections(rawDiff: string): string[] {
  // Strip only leading whitespace (for the startsWith filter) and the
  // trailing "\n" terminator(s) of git stdout — never a blanket trim(): the
  // physical last data line may carry significant trailing bytes (spaces, or
  // the "\r" of a CRLF file) that anchor byte-exactness depends on.
  const trimmed = rawDiff.replace(/^\s+/, "").replace(/\n+$/, "");

  if (trimmed.length === 0) return [];

  return trimmed
    .split(/\n(?=diff --git )/)
    .filter((s) => s.startsWith("diff --git"));
}

function repoRelPath(p: string): string {
  if (p.startsWith("a/") || p.startsWith("b/")) return p.slice(2);

  return p;
}

function parsePath(headerLine: string): string {
  // "diff --git a/<old> b/<new>" — take the new (b/) path, the last token.
  const match = headerLine.match(/ b\/(.+)$/);

  if (match) return match[1];

  const tokens = headerLine.split(" ");

  return repoRelPath(tokens[tokens.length - 1] ?? "");
}

function parseOldPath(headerLine: string): string | undefined {
  const match = headerLine.match(/^diff --git a\/(.+) b\/(.+)$/);

  if (match) return match[1];

  return undefined;
}

function deriveStatus(section: string): string {
  if (/^new file mode /m.test(section)) return "A";
  if (/^deleted file mode /m.test(section)) return "D";
  if (/^rename (from|to) /m.test(section)) return "R";
  if (/^copy (from|to) /m.test(section)) return "C";

  return "M";
}

function countChanges(section: string): {
  additions: number;
  deletions: number;
  syntaxLines: number;
} {
  let additions = 0;
  let deletions = 0;
  let contextLines = 0;
  let inHunk = false;

  for (const line of section.split("\n")) {
    if (line.startsWith("@@ ")) {
      inHunk = true;
      continue;
    }
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) additions += 1;
    else if (line.startsWith("-")) deletions += 1;
    else if (inHunk && line.startsWith(" ")) contextLines += 1;
  }

  return {
    additions,
    deletions,
    syntaxLines: additions + deletions + contextLines,
  };
}

function parseSection(section: string): ParsedSection {
  const headerLine = section.split("\n", 1)[0];
  const path = parsePath(headerLine);
  const oldPath = parseOldPath(headerLine);
  const status = deriveStatus(section);
  const { additions, deletions, syntaxLines } = countChanges(section);

  return { section, path, oldPath, status, additions, deletions, syntaxLines };
}

function summarizeSections(sections: ParsedSection[]): DiffFileSummary[] {
  return sections.map((s) => ({
    path: s.path,
    ...(s.oldPath && s.oldPath !== s.path ? { oldPath: s.oldPath } : {}),
    status: s.status,
    additions: s.additions,
    deletions: s.deletions,
  }));
}

export function filterDiffByPath(
  rawDiff: string,
  includePath: (path: string, oldPath: string | undefined) => boolean,
): string {
  const sections = splitSections(rawDiff)
    .map(parseSection)
    .filter((section) => includePath(section.path, section.oldPath))
    .map((section) => section.section);

  return sections.length > 0 ? `${sections.join("\n")}\n` : "";
}

export function prepareDiffSummary(
  rawDiff: string,
  truncated = false,
): Pick<DiffPrepResult, "files" | "truncated"> {
  return {
    files: summarizeSections(splitSections(rawDiff).map(parseSection)),
    truncated,
  };
}

function buildBundle(
  parsed: ParsedSection,
  fileLang: string,
  registerHighlighter: DiffFileHighlighter,
): ReturnType<DiffFile["_getFullBundle"]> {
  const file = new DiffFile(
    parsed.path,
    "",
    parsed.path,
    "",
    [parsed.section],
    fileLang,
    fileLang,
  );

  file.initTheme("light");
  file.initRaw();
  file.initSyntax({ registerHighlighter });
  // The bundle only carries split/unified line layout if it is built before
  // serialization; without these the client diff hydrates an empty body.
  file.buildSplitDiffLines();
  file.buildUnifiedDiffLines();

  // `_getFullBundle` (NOT `getBundle`) carries `oldFileResult`/`newFileResult`.
  // The client's `createInstance(data, fullBundle)` auto-dispatches to
  // `_mergeFullBundle`, which restores those results — so git-diff-view's
  // `initSyntax()` early-return reads back the merged `syntaxFile` instead of
  // wiping it (the lite `getBundle()` omits them, so the syntax is lost on
  // hydration and the diff falls back to plain text).
  return file._getFullBundle();
}

// Single-pass plain-prototype projection: `DiffFile._getFullBundle()` contains
// class instances and null-proto records that React Flight refuses to cross the
// Server→Client boundary. Normalizing directly avoids the double allocation of
// `JSON.parse(JSON.stringify(...))` while omitting template/AST bloat and
// slimming HAST wrappers to `{ properties }`.
function sanitizeValue(value: unknown): unknown {
  if (value === null) return null;

  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      return Number.isFinite(value) ? value : null;
    case "object":
      break;
    default:
      return undefined;
  }

  if (Array.isArray(value)) {
    const out: unknown[] = [];

    for (let i = 0; i < value.length; i += 1) {
      const sanitized = sanitizeValue(value[i]);

      out.push(sanitized === undefined ? null : sanitized);
    }

    return out;
  }

  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  for (const key of Object.keys(source)) {
    if (OMITTED_DIFF_BUNDLE_KEYS.has(key)) continue;

    const prop = source[key];

    if (
      key === "wrapper" &&
      prop !== null &&
      typeof prop === "object" &&
      "properties" in prop
    ) {
      const properties = (prop as { properties: unknown }).properties;
      const sanitizedProps = sanitizeValue(properties);

      out[key] =
        sanitizedProps === undefined ? {} : { properties: sanitizedProps };
      continue;
    }

    const sanitized = sanitizeValue(prop);

    if (sanitized !== undefined) {
      out[key] = sanitized;
    }
  }

  return out;
}

function sanitizeDiffBundle(
  bundle: ReturnType<DiffFile["_getFullBundle"]>,
): ReturnType<DiffFile["_getFullBundle"]> {
  return sanitizeValue(bundle) as ReturnType<DiffFile["_getFullBundle"]>;
}

function yieldToEventLoop(): Promise<void> {
  return new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

export async function prepareDiff(
  rawDiff: string,
  truncated = false,
): Promise<DiffPrepResult> {
  const startedAt = performance.now();
  const sections = splitSections(rawDiff).map(parseSection);

  if (sections.length === 0) {
    return { files: [], perFile: [], truncated };
  }

  let syntaxLinesUsed = 0;
  let budgetExhausted = false;
  let highlightedFiles = 0;
  let plaintextFallbackFiles = 0;
  const langsToPreload = new Set<string>();

  const sectionPlans = sections.map((section) => {
    const detectedLang = langFromPath(section.path);
    const fitsBudget =
      !budgetExhausted &&
      syntaxLinesUsed + section.syntaxLines <= MAX_TOTAL_SYNTAX_LINES;

    if (fitsBudget) {
      syntaxLinesUsed += section.syntaxLines;
      highlightedFiles += 1;
      langsToPreload.add(detectedLang);

      return { section, fileLang: detectedLang, usePlaintext: false };
    }

    budgetExhausted = true;
    plaintextFallbackFiles += 1;

    return { section, fileLang: "plaintext", usePlaintext: true };
  });

  if (langsToPreload.size > 0) {
    await preloadDiffLangs([...langsToPreload]);
  }

  const files = summarizeSections(sections);
  const perFile: PreparedFile[] = [];
  const DIFF_YIELD_BUDGET_MS = 16;
  let yieldCount = 0;
  let index = 0;

  while (index < sectionPlans.length) {
    const batchEnd = Math.min(
      index + DIFF_YIELD_BATCH_SIZE,
      sectionPlans.length,
    );
    const batchStartedAt = performance.now();
    const wasBuildingTemplates = getEnableBuildTemplate();

    setEnableBuildTemplate(false);
    try {
      while (index < batchEnd) {
        const plan = sectionPlans[index];
        const highlighter = plan.usePlaintext
          ? plaintextDiffHighlighter
          : shikiDiffHighlighter;

        perFile.push({
          path: plan.section.path,
          fileLang: plan.fileLang,
          bundle: sanitizeDiffBundle(
            buildBundle(plan.section, plan.fileLang, highlighter),
          ),
        });
        index += 1;

        if (
          index < batchEnd &&
          performance.now() - batchStartedAt >= DIFF_YIELD_BUDGET_MS
        ) {
          break;
        }
      }
    } finally {
      setEnableBuildTemplate(wasBuildingTemplates);
    }

    if (index < sectionPlans.length) {
      yieldCount += 1;
      await yieldToEventLoop();
    }
  }

  const durationMs = Math.round(performance.now() - startedAt);
  const totalAdditions = files.reduce((n, f) => n + f.additions, 0);
  const totalDeletions = files.reduce((n, f) => n + f.deletions, 0);

  log.debug(
    {
      fileCount: files.length,
      additions: totalAdditions,
      deletions: totalDeletions,
      highlightedFiles,
      plaintextFallbackFiles,
      yieldCount,
      durationMs,
    },
    "prepareDiff",
  );

  if (plaintextFallbackFiles > 0) {
    log.info(
      {
        fileCount: files.length,
        highlightedFiles,
        plaintextFallbackFiles,
        maxTotalSyntaxLines: MAX_TOTAL_SYNTAX_LINES,
        durationMs,
      },
      "prepareDiff syntax budget exceeded — trailing files downgraded to plaintext",
    );
  }

  return { files, perFile, truncated };
}
