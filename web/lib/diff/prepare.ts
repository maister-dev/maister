import "server-only";

import { DiffFile } from "@git-diff-view/core";
import pino from "pino";

import { shikiDiffHighlighter } from "@/lib/diff/shiki-adapter";
import { langFromPath, preloadDiffLangs } from "@/lib/highlight/shiki";

const log = pino({
  name: "diff-prepare",
  level: process.env.LOG_LEVEL ?? "info",
});

export type DiffFileSummary = {
  path: string;
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
};

type ParsedSection = {
  section: string;
  path: string;
  status: string;
  additions: number;
  deletions: number;
};

// A unified diff is concatenated per-file sections, each starting with
// "diff --git a/<old> b/<new>". Mirrors extractFileSection's split regex.
function splitSections(rawDiff: string): string[] {
  const trimmed = rawDiff.trim();

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
} {
  let additions = 0;
  let deletions = 0;

  for (const line of section.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) additions += 1;
    else if (line.startsWith("-")) deletions += 1;
  }

  return { additions, deletions };
}

function parseSection(section: string): ParsedSection {
  const headerLine = section.split("\n", 1)[0];
  const path = parsePath(headerLine);
  const status = deriveStatus(section);
  const { additions, deletions } = countChanges(section);

  return { section, path, status, additions, deletions };
}

function buildBundle(
  parsed: ParsedSection,
  fileLang: string,
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
  file.initSyntax({ registerHighlighter: shikiDiffHighlighter });
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

export async function prepareDiff(rawDiff: string): Promise<DiffPrepResult> {
  const sections = splitSections(rawDiff).map(parseSection);

  if (sections.length === 0) {
    return { files: [], perFile: [] };
  }

  const langByPath = new Map<string, string>();

  for (const section of sections) {
    langByPath.set(section.path, langFromPath(section.path));
  }

  await preloadDiffLangs([...new Set(langByPath.values())]);

  const files: DiffFileSummary[] = sections.map((s) => ({
    path: s.path,
    status: s.status,
    additions: s.additions,
    deletions: s.deletions,
  }));

  const perFile: PreparedFile[] = sections.map((s) => {
    const fileLang = langByPath.get(s.path) ?? "plaintext";

    return { path: s.path, fileLang, bundle: buildBundle(s, fileLang) };
  });

  const totalAdditions = files.reduce((n, f) => n + f.additions, 0);
  const totalDeletions = files.reduce((n, f) => n + f.deletions, 0);

  log.debug(
    {
      fileCount: files.length,
      additions: totalAdditions,
      deletions: totalDeletions,
    },
    "prepareDiff",
  );

  // Normalize to a plain-object DTO: `getBundle()` returns null-proto/class-y
  // structures that React Flight refuses to serialize across the
  // Server→Client boundary (the review panel takes the DTO as a prop). The
  // bundle is already JSON-representable (it ships JSON via the /diff route),
  // so this roundtrip is lossless and doubles as the FINDING-C plain projection.
  return JSON.parse(JSON.stringify({ files, perFile })) as DiffPrepResult;
}
