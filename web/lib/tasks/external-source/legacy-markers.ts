import type { TaskSource, TaskSourceIdentity } from "./model";

// ADR-206 legacy backfill: GitHub intake wrote identity only as prompt text.
// Classification is exact — no title similarity, no number inference.

export type LegacySourceClassification =
  | "bindable"
  | "already_bound_same"
  | "no_markers"
  | "incomplete"
  | "malformed"
  | "conflicting"
  | "duplicate";

export type LegacySourceCandidate = {
  taskId: string;
  taskKey: string;
  projectId: string;
  title: string;
  texts: string[];
  bound: TaskSourceIdentity | null;
};

export type LegacySourceResult = {
  taskId: string;
  taskKey: string;
  classification: LegacySourceClassification;
  source?: TaskSource;
};

const ID_MARKER = /Source-GitHub-ID:\s*`?([^\s`]+)/g;
const ISSUE_MARKER = /Source-GitHub-Issue:\s*<?`?([^\s`>]+)/g;
const NODE_ID = /^I_[A-Za-z0-9_-]+$/;
const ISSUE_PATH = /^\/([^/]+)\/([^/]+)\/issues\/([1-9][0-9]*)\/?$/;
const TITLE_NUMBER = /^\[GitHub #([0-9]+)\]/;

function distinctMatches(texts: string[], pattern: RegExp): string[] {
  const values = new Set<string>();

  for (const text of texts) {
    for (const match of text.matchAll(pattern)) values.add(match[1]);
  }

  return [...values];
}

function parseIssueUrl(
  raw: string,
): { host: string; scope: string; number: string } | null {
  let url: URL;

  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const path = ISSUE_PATH.exec(url.pathname);

  if (url.protocol !== "https:" || url.username || url.password || !path) {
    return null;
  }

  return {
    host: url.hostname.toLowerCase(),
    scope: `${path[1]}/${path[2]}`.toLowerCase(),
    number: path[3],
  };
}

function classifyOne(candidate: LegacySourceCandidate): LegacySourceResult {
  const base = { taskId: candidate.taskId, taskKey: candidate.taskKey };
  const ids = distinctMatches(candidate.texts, ID_MARKER);
  const urls = distinctMatches(candidate.texts, ISSUE_MARKER);

  if (ids.length === 0 && urls.length === 0) {
    return { ...base, classification: "no_markers" };
  }
  if (ids.length > 1 || urls.length > 1) {
    return { ...base, classification: "conflicting" };
  }
  if (ids.length === 0 || urls.length === 0) {
    return { ...base, classification: "incomplete" };
  }

  const issue = parseIssueUrl(urls[0]);

  if (!NODE_ID.test(ids[0]) || !issue) {
    return { ...base, classification: "malformed" };
  }

  const titleNumber = TITLE_NUMBER.exec(candidate.title)?.[1];

  if (titleNumber !== undefined && titleNumber !== issue.number) {
    return { ...base, classification: "conflicting" };
  }

  const source: TaskSource = {
    kind: "github",
    instance: issue.host,
    scope: issue.scope,
    externalId: ids[0],
    externalKey: `#${issue.number}`,
    url: `https://${issue.host}/${issue.scope}/issues/${issue.number}`,
  };

  if (candidate.bound) {
    const same =
      candidate.bound.kind === source.kind &&
      candidate.bound.instance === source.instance &&
      candidate.bound.externalId === source.externalId;

    return {
      ...base,
      classification: same ? "already_bound_same" : "conflicting",
    };
  }

  return { ...base, classification: "bindable", source };
}

function identityKey(projectId: string, identity: TaskSourceIdentity): string {
  return `${projectId}\u0000${identity.kind}\u0000${identity.instance}\u0000${identity.externalId}`;
}

export function classifyLegacyGithubSources(
  candidates: LegacySourceCandidate[],
): LegacySourceResult[] {
  const results = candidates.map(classifyOne);
  const claimants = new Map<string, number>();

  // Every bound identity (whatever this task's markers say) and every
  // bindable one is a claimant; an identity with two claimants is never bound.
  candidates.forEach((candidate, index) => {
    const result = results[index];
    const identity =
      result.classification === "bindable" ? result.source : candidate.bound;

    if (!identity) return;
    const key = identityKey(candidate.projectId, identity);

    claimants.set(key, (claimants.get(key) ?? 0) + 1);
  });

  return results.map((result, index) => {
    if (result.classification !== "bindable" || !result.source) return result;

    const key = identityKey(candidates[index].projectId, result.source);

    return (claimants.get(key) ?? 0) > 1
      ? {
          taskId: result.taskId,
          taskKey: result.taskKey,
          classification: "duplicate",
        }
      : result;
  });
}
