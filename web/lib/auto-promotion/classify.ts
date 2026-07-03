import type {
  AutoPromotionConfig,
  AutoPromotionLane,
  LaneClass,
} from "./config";
import type { DiffChangeStatEntry } from "@/lib/worktree";

import picomatch from "picomatch";

// ADR-126 §4.3: pure path classifier. Deny-list is evaluated BEFORE lane
// matching, is non-configurable, and defeats every lane. The built-in lane
// globs are deliberately NOT disjoint (`**/__tests__/**` ∩ `**/*.md`, etc.), so
// a file matching ≥2 enabled lanes is `ambiguous_lane` (fail-to-manual), never
// silently forced into one lane.

const MATCH_OPTS = { dot: true } as const;
const NAMED_FILE_CAP = 5;

// Non-configurable security boundary (prompt-injection / secret / CI surfaces).
// Root-anchored agent dirs; `.env`/manifest/agent-instruction files at any depth.
// Exported read-only so the settings UI (T18) can render the deny-list.
export const HARD_DENY_GLOBS = [
  ".github/workflows/**",
  ".env*",
  "**/.env*",
  "maister.yaml",
  "**/maister.yaml",
  "CLAUDE.md",
  "**/CLAUDE.md",
  "AGENTS.md",
  "**/AGENTS.md",
  "GEMINI.md",
  "**/GEMINI.md",
  ".claude/**",
  ".codex/**",
  ".agents/**",
  ".ai-factory/**",
];

// Base config-file patterns; each is matched at the repo root AND `**/`-nested.
const CONFIG_BASE_GLOBS = [
  ".gitignore",
  ".gitattributes",
  ".editorconfig",
  ".prettierrc*",
  "prettier.config.*",
  "eslint.config.*",
  ".eslintrc*",
  "stylelint*",
  ".stylelintrc*",
  "markdownlint*",
  ".markdownlint*",
];

const LANE_GLOBS: Record<LaneClass, string[]> = {
  docs: [
    "**/*.md",
    "**/*.mdx",
    "docs/**",
    "docs/**/*.{png,jpg,jpeg,gif,svg,webp}",
  ],
  tests: [
    "**/*.test.*",
    "**/*.spec.*",
    "**/__tests__/**",
    "e2e/**",
    "**/e2e/**",
    "**/__fixtures__/**",
    "**/fixtures/**",
  ],
  deps: [
    "**/package.json",
    "pnpm-lock.yaml",
    "**/pnpm-lock.yaml",
    "package-lock.json",
    "yarn.lock",
  ],
  config: CONFIG_BASE_GLOBS.flatMap((g) => [g, `**/${g}`]),
};

type Matcher = (input: string) => boolean;

function compile(globs: string[]): Matcher {
  return picomatch(globs, MATCH_OPTS);
}

const DENY_MATCHER = compile(HARD_DENY_GLOBS);
const LANE_MATCHERS: Record<LaneClass, Matcher> = {
  docs: compile(LANE_GLOBS.docs),
  tests: compile(LANE_GLOBS.tests),
  deps: compile(LANE_GLOBS.deps),
  config: compile(LANE_GLOBS.config),
};

export type ClassifyVerdict =
  | { kind: "eligible"; lane: LaneClass }
  | { kind: "denied"; files: string[] }
  | { kind: "empty_diff" }
  | { kind: "no_lane"; files: string[] }
  | { kind: "ambiguous_lane"; files: string[] };

// A rename carries two endpoints (new `path` + old `oldPath`); both must satisfy
// a lane for it to claim the file — a rename INTO docs FROM src is not docs-only.
function endpoints(entry: DiffChangeStatEntry): string[] {
  return entry.oldPath ? [entry.path, entry.oldPath] : [entry.path];
}

function laneMatchesFile(
  lane: AutoPromotionLane,
  entry: DiffChangeStatEntry,
): boolean {
  const eps = endpoints(entry);

  if (!eps.every((ep) => LANE_MATCHERS[lane.class](ep))) return false;

  // An excludeGlob-subtracted endpoint removes the lane from this file's match
  // set (excluded file ⇒ unmatched for this lane ⇒ fail-to-manual).
  if (lane.excludeGlobs?.length) {
    const excluded = compile(lane.excludeGlobs);

    if (eps.some((ep) => excluded(ep))) return false;
  }

  return true;
}

// Path-only classification. `deps` eligibility here is path-wise; the caller runs
// the deps content check (§4.3 / deps-check.ts) before promoting a deps lane.
export function classifyDiff(
  files: DiffChangeStatEntry[],
  config: AutoPromotionConfig,
): ClassifyVerdict {
  const denied = files.filter((f) =>
    endpoints(f).some((ep) => DENY_MATCHER(ep)),
  );

  if (denied.length > 0) {
    return {
      kind: "denied",
      files: denied.map((f) => f.path).slice(0, NAMED_FILE_CAP),
    };
  }

  if (files.length === 0) return { kind: "empty_diff" };

  const enabledLanes = config.lanes.filter((l) => l.enabled);
  const ambiguous: string[] = [];
  const unmatched: string[] = [];
  const laneReps = new Map<LaneClass, string>();
  let assignedLane: LaneClass | null = null;
  let mixed = false;

  for (const f of files) {
    const matched = enabledLanes.filter((l) => laneMatchesFile(l, f));

    if (matched.length >= 2) {
      ambiguous.push(f.path);
      continue;
    }

    if (matched.length === 0) {
      unmatched.push(f.path);
      continue;
    }

    const cls = matched[0].class;

    if (!laneReps.has(cls)) laneReps.set(cls, f.path);

    if (assignedLane === null) assignedLane = cls;
    else if (assignedLane !== cls) mixed = true;
  }

  // A single overlapping file is a stronger "operator globs collide" signal than
  // an unmatched file — surface it first. Both fail to manual.
  if (ambiguous.length > 0) {
    return {
      kind: "ambiguous_lane",
      files: ambiguous.slice(0, NAMED_FILE_CAP),
    };
  }

  if (unmatched.length > 0) {
    return { kind: "no_lane", files: unmatched.slice(0, NAMED_FILE_CAP) };
  }

  // Every file matched exactly one lane; a mix of distinct lanes has no single
  // lane covering ALL files ⇒ no_lane (name one representative file per lane).
  if (mixed || assignedLane === null) {
    return {
      kind: "no_lane",
      files: [...laneReps.values()].slice(0, NAMED_FILE_CAP),
    };
  }

  return { kind: "eligible", lane: assignedLane };
}
