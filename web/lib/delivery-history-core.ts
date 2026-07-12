import type {
  DeliveryDiffStat,
  DeliveryFileStat,
} from "@/lib/delivery-pathspec";

import { cleanDeliveryStats } from "@/lib/delivery-pathspec";

const COMMIT_PREFIX = "__MAISTER_COMMIT__";

export type DeliveryHistoryCommit = {
  sha: string;
  parents: string[];
  files: DeliveryFileStat[];
};

export type TimestampedDeliveryHistoryCommit = DeliveryHistoryCommit & {
  committedAt: Date;
  message: string;
};

function parseCount(raw: string, line: string): number {
  if (raw === "-") return 0;

  const parsed = Number.parseInt(raw, 10);

  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new RangeError(
      `git log --numstat returned an invalid count: ${line}`,
    );
  }

  return parsed;
}

function parseFileStat(line: string): DeliveryFileStat {
  const [additionsRaw, deletionsRaw, ...pathParts] = line.split("\t");
  const path = pathParts.join("\t");

  if (!additionsRaw || !deletionsRaw || !path) {
    throw new RangeError(`git log --numstat returned an invalid row: ${line}`);
  }

  return {
    path,
    additions: parseCount(additionsRaw, line),
    deletions: parseCount(deletionsRaw, line),
    binary: additionsRaw === "-" || deletionsRaw === "-",
  };
}

function parseCommitHeader(line: string): DeliveryHistoryCommit {
  const [sha, parentText] = line.slice(COMMIT_PREFIX.length).split("\t", 2);

  if (!sha) {
    throw new RangeError(`git log returned an invalid commit header: ${line}`);
  }

  return {
    sha,
    parents: parentText ? parentText.split(" ").filter(Boolean) : [],
    files: [],
  };
}

export function parseDeliveryHistory(stdout: string): DeliveryHistoryCommit[] {
  const commits: DeliveryHistoryCommit[] = [];
  let current: DeliveryHistoryCommit | null = null;

  for (const line of stdout.split("\n")) {
    if (line.length === 0) continue;

    if (line.startsWith(COMMIT_PREFIX)) {
      current = parseCommitHeader(line);
      commits.push(current);

      continue;
    }

    if (!current) {
      throw new RangeError(
        "git log --numstat returned a file row before a commit header",
      );
    }

    current.files.push(parseFileStat(line));
  }

  return commits;
}

export function summarizeDeliveryHistory(
  commits: readonly DeliveryHistoryCommit[],
): DeliveryDiffStat {
  return commits.reduce<DeliveryDiffStat>(
    (total, commit) => {
      const stat = cleanDeliveryStats(commit.files);

      return {
        files: total.files + stat.files,
        additions: total.additions + stat.additions,
        deletions: total.deletions + stat.deletions,
      };
    },
    { files: 0, additions: 0, deletions: 0 },
  );
}

export const DELIVERY_HISTORY_GIT_FORMAT = `${COMMIT_PREFIX}%H%x09%P`;
export const DELIVERY_HISTORY_NUL_GIT_FORMAT = "%H%x00%ct%x00%P%x00%B%x00";

const COMMIT_SHA = /^[0-9a-f]{7,64}$/i;
const NUMSTAT_ROW = /^(-|\d+)\t(-|\d+)\t(.*)$/s;

function parseTimestamp(raw: string): Date {
  const seconds = Number.parseInt(raw, 10);

  if (!Number.isSafeInteger(seconds) || seconds < 0) {
    throw new RangeError(
      `git log returned an invalid commit timestamp: ${raw}`,
    );
  }

  return new Date(seconds * 1_000);
}

function headerToken(raw: string): string {
  return raw.startsWith("\n") ? raw.slice(1) : raw;
}

function isCommitHeader(fields: readonly string[], index: number): boolean {
  const sha = headerToken(fields[index] ?? "");
  const timestamp = fields[index + 1] ?? "";

  return COMMIT_SHA.test(sha) && /^\d+$/.test(timestamp);
}

function parseNulNumstat(
  fields: readonly string[],
  index: number,
): { entry: DeliveryFileStat; nextIndex: number } {
  const sourceRow = fields[index];
  const row = sourceRow?.startsWith("\n") ? sourceRow.slice(1) : sourceRow;
  const match = row?.match(NUMSTAT_ROW);

  if (!match) {
    throw new RangeError(
      `git log --numstat returned an invalid NUL row: ${JSON.stringify(row)}`,
    );
  }

  const [, additionsRaw, deletionsRaw, pathRaw] = match;
  const binary = additionsRaw === "-" || deletionsRaw === "-";
  const additions = parseCount(additionsRaw, row);
  const deletions = parseCount(deletionsRaw, row);

  if (pathRaw.length > 0) {
    return {
      entry: { path: pathRaw, additions, deletions, binary },
      nextIndex: index + 1,
    };
  }

  const oldPath = fields[index + 1];
  const path = fields[index + 2];

  if (!oldPath || !path) {
    throw new RangeError("git log --numstat returned an invalid rename row");
  }

  return {
    entry: { path, oldPath, additions, deletions, binary },
    nextIndex: index + 3,
  };
}

// `git log --numstat -z` emits one NUL-delimited pretty-format header followed
// by NUL-delimited numstat rows. A NUL cannot occur in either a commit message
// or a repository path, which keeps parsing unambiguous for arbitrary messages
// and special-character paths.
export function parseTimestampedDeliveryHistory(
  stdout: string,
): TimestampedDeliveryHistoryCommit[] {
  const fields = stdout.split("\0");
  const commits: TimestampedDeliveryHistoryCommit[] = [];
  let index = 0;

  while (index < fields.length) {
    if (fields[index] === "" || fields[index] === "\n") {
      index += 1;
      continue;
    }

    if (!isCommitHeader(fields, index)) {
      throw new RangeError(
        `git log --numstat expected a commit header: ${JSON.stringify(fields[index])}`,
      );
    }

    const sha = headerToken(fields[index] ?? "").toLowerCase();
    const committedAt = parseTimestamp(fields[index + 1] ?? "");
    const parents = (fields[index + 2] ?? "").split(" ").filter(Boolean);
    const message = fields[index + 3] ?? "";
    const files: DeliveryFileStat[] = [];

    index += 4;

    while (index < fields.length && !isCommitHeader(fields, index)) {
      if (fields[index] === "") {
        index += 1;
        continue;
      }

      const parsed = parseNulNumstat(fields, index);

      files.push(parsed.entry);
      index = parsed.nextIndex;
    }

    commits.push({ sha, parents, committedAt, message, files });
  }

  return commits;
}
