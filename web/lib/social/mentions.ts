import "server-only";

import { and, eq, or } from "drizzle-orm";
import pino from "pino";

import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";

// FIXME(any): dual drizzle-orm peer-dep variants (matches lib/services/tasks.ts).
const { projects, tasks } = schemaModule as unknown as Record<string, any>;

// FIXME(any): dual drizzle-orm peer-dep variants.
type Db = any;

const log = pino({
  name: "social-mentions",
  level: process.env.LOG_LEVEL ?? "info",
});

export type MarkdownSegment = {
  kind: "text" | "code" | "link";
  value: string;
};

const PG_INT4_MAX = 2_147_483_647;

// ADR-151. ONE alternation over both token families so a text segment is
// consumed left to right exactly once: a stem may itself look like `KEY-N`
// (`@core:MAI-1`), and two independent passes would rewrite it twice.
// The agent branch opens only at a word boundary — start of segment,
// whitespace, or `(` — which is what keeps `user@example.com` inert.
const AGENT_HANDLE = "[A-Za-z0-9._-]+(?::[A-Za-z0-9._-]+)?";
const MENTION_TOKENS = new RegExp(
  `(^|[\\s(])@(${AGENT_HANDLE})|\\b([A-Z][A-Z0-9]{1,9})-(\\d+)\\b`,
  "g",
);

// The handle ends on its last alphanumeric, so trailing sentence punctuation
// (`@triager.`) stays outside the link.
function trimAgentHandle(raw: string): string {
  let end = raw.length;

  while (end > 0 && !/[A-Za-z0-9]/.test(raw[end - 1])) end -= 1;

  return raw.slice(0, end);
}

function segmentInline(chunk: string, out: MarkdownSegment[]): void {
  let text = "";
  let i = 0;

  const flushText = () => {
    if (text.length > 0) {
      out.push({ kind: "text", value: text });
      text = "";
    }
  };

  while (i < chunk.length) {
    const ch = chunk[i];

    if (ch === "`") {
      let runLen = 1;

      while (chunk[i + runLen] === "`") runLen += 1;

      // Closing run must be exactly the opener's length (commonmark-style):
      // scan backtick runs after the opener.
      let j = i + runLen;
      let closeStart = -1;

      while (j < chunk.length) {
        if (chunk[j] === "`") {
          let len = 1;

          while (chunk[j + len] === "`") len += 1;
          if (len === runLen) {
            closeStart = j;
            break;
          }
          j += len;
        } else {
          j += 1;
        }
      }

      if (closeStart !== -1) {
        flushText();
        out.push({
          kind: "code",
          value: chunk.slice(i, closeStart + runLen),
        });
        i = closeStart + runLen;
        continue;
      }
      // No closer — literal backticks.
      text += chunk.slice(i, i + runLen);
      i += runLen;
      continue;
    }

    if (ch === "[") {
      const labelEnd = chunk.indexOf("]", i + 1);

      if (labelEnd !== -1 && chunk[labelEnd + 1] === "(") {
        const targetEnd = chunk.indexOf(")", labelEnd + 2);

        if (targetEnd !== -1) {
          flushText();
          out.push({ kind: "link", value: chunk.slice(i, targetEnd + 1) });
          i = targetEnd + 1;
          continue;
        }
      }
      text += ch;
      i += 1;
      continue;
    }

    text += ch;
    i += 1;
  }

  flushText();
}

// Scanner, not regex-only: fenced code blocks are line-based; inline code
// spans and markdown links are carved within the remaining text. Segments
// re-join to the exact original body.
export function segmentMarkdown(body: string): MarkdownSegment[] {
  const out: MarkdownSegment[] = [];
  const lines = body.split(/(?<=\n)/);

  let fence: { char: string; len: number; value: string } | null = null;
  let textChunk = "";

  const flushTextChunk = () => {
    if (textChunk.length > 0) {
      segmentInline(textChunk, out);
      textChunk = "";
    }
  };

  for (const line of lines) {
    if (fence) {
      fence.value += line;
      const close = line.match(/^\s{0,3}(`{3,}|~{3,})\s*$/);

      if (close && close[1][0] === fence.char && close[1].length >= fence.len) {
        out.push({ kind: "code", value: fence.value });
        fence = null;
      }
      continue;
    }

    const open = line.match(/^\s{0,3}(`{3,}|~{3,})/);

    if (open) {
      flushTextChunk();
      fence = { char: open[1][0], len: open[1].length, value: line };
      continue;
    }

    textChunk += line;
  }

  flushTextChunk();
  if (fence) {
    // Unclosed fence runs to the end of the body — still a skip zone.
    out.push({ kind: "code", value: fence.value });
  }

  return out;
}

export type MentionCandidate = { key: string; number: number };

export function collectMentionCandidates(
  segments: MarkdownSegment[],
): MentionCandidate[] {
  const seen = new Set<string>();
  const candidates: MentionCandidate[] = [];

  for (const segment of segments) {
    if (segment.kind !== "text") continue;
    for (const match of segment.value.matchAll(MENTION_TOKENS)) {
      // An agent handle consumed this position; a `KEY-N`-shaped stem inside
      // it is part of the handle, not a task reference.
      if (match[2] !== undefined) continue;

      const key = match[3];
      const number = Number.parseInt(match[4], 10);

      if (number < 1 || number > PG_INT4_MAX) continue;

      const token = `${key}-${number}`;

      if (seen.has(token)) continue;
      seen.add(token);
      candidates.push({ key, number });
    }
  }

  return candidates;
}

export function collectAgentMentionCandidates(
  segments: MarkdownSegment[],
): string[] {
  const seen = new Set<string>();
  const handles: string[] = [];

  for (const segment of segments) {
    if (segment.kind !== "text") continue;
    for (const match of segment.value.matchAll(MENTION_TOKENS)) {
      if (match[2] === undefined) continue;

      const handle = trimAgentHandle(match[2]);

      if (handle.length === 0 || seen.has(handle)) continue;
      seen.add(handle);
      handles.push(handle);
    }
  }

  return handles;
}

/** One project-attached agent a handle may resolve to. */
// ADR-152: why an attached agent is not summonable — one member per conjunct of
// the ADR-151 predicate. Declaration order IS the precedence order.
export const SUMMON_BLOCKED_REASONS = [
  "link_disabled",
  "agent_disabled",
  "quarantined",
  "trigger_missing",
  "mention_binding_missing",
] as const;

export type SummonBlockedReason = (typeof SUMMON_BLOCKED_REASONS)[number];

export type MentionableAgent = {
  id: string;
  stem: string;
  name: string;
  summonable: boolean;
  // Null exactly when `summonable` is true — the two are derived from ONE
  // evaluation, so they can never disagree.
  blockedReason: SummonBlockedReason | null;
  // ADR-152: the ATTACHMENT axis (`agent_project_links.enabled`), distinct from
  // the catalog axis (`agents.enabled`). The assistant pulse reports this one,
  // so a catalog-disabled agent on a live attachment still reads as attached.
  linkEnabled: boolean;
};

export type ResolvedAgentMention = {
  id: string;
  name: string;
  summonable: boolean;
};

// Pure: the candidate set is injected, so resolution has no DB dependency.
// Bare-stem uniqueness is computed over EVERY attached agent, not only the
// summonable ones — otherwise enabling a binding would silently change which
// agent an existing `@stem` refers to.
export function resolveAgentMentions(
  handles: string[],
  agents: MentionableAgent[],
): Map<string, ResolvedAgentMention> {
  const byId = new Map(agents.map((a) => [a.id, a]));
  const byStem = new Map<string, MentionableAgent[]>();

  for (const agent of agents) {
    byStem.set(agent.stem, [...(byStem.get(agent.stem) ?? []), agent]);
  }

  const resolved = new Map<string, ResolvedAgentMention>();

  for (const handle of handles) {
    const hit = handle.includes(":")
      ? byId.get(handle)
      : (byStem.get(handle) ?? []).length === 1
        ? byStem.get(handle)![0]
        : undefined;

    if (!hit) continue;
    resolved.set(handle, {
      id: hit.id,
      name: hit.name,
      summonable: hit.summonable,
    });
  }

  return resolved;
}

export type ResolvedMention = {
  slug: string;
  key: string;
  number: number;
};

export function expandResolvedMentions(
  segments: MarkdownSegment[],
  resolved: Map<string, ResolvedMention>,
  agents: Map<string, ResolvedAgentMention> = new Map(),
): string {
  return segments
    .map((segment) => {
      if (segment.kind !== "text") return segment.value;

      return segment.value.replace(
        MENTION_TOKENS,
        (
          token,
          boundary: string | undefined,
          handle: string | undefined,
          key: string | undefined,
          num: string | undefined,
        ) => {
          if (handle !== undefined) {
            const trimmed = trimAgentHandle(handle);
            const agent = agents.get(trimmed);

            if (!agent) return token;

            // The leading `/` is load-bearing: without it react-markdown's
            // urlTransform reads `core:` as a URL scheme and drops the link.
            return `${boundary ?? ""}[@${agent.id}](/agents/${agent.id})${handle.slice(
              trimmed.length,
            )}`;
          }

          const hit = resolved.get(`${key}-${Number.parseInt(num ?? "", 10)}`);

          if (!hit) return token;

          return `[${hit.key}-${hit.number}](/projects/${hit.slug}/tasks/${hit.number})`;
        },
      );
    })
    .join("");
}

export type ExpandedMentions = {
  expanded: string;
  mentioned: Array<{
    taskId: string;
    projectId: string;
    key: string;
    number: number;
  }>;
  mentionedAgents: Array<{ id: string; name: string; summonable: boolean }>;
};

export async function expandMentions(
  body: string,
  db?: Db,
  agentCandidates: MentionableAgent[] = [],
): Promise<ExpandedMentions> {
  const _db = (db ?? getDb()) as unknown as { select: any };
  const segments = segmentMarkdown(body);
  const candidates = collectMentionCandidates(segments);
  const agents = resolveAgentMentions(
    collectAgentMentionCandidates(segments),
    agentCandidates,
  );
  // Deduped by construction: one entry per resolved AGENT, however many
  // handles (canonical + bare) pointed at it.
  const mentionedAgents = [
    ...new Map([...agents.values()].map((a) => [a.id, a])).values(),
  ];

  if (candidates.length === 0) {
    return {
      expanded:
        agents.size > 0
          ? expandResolvedMentions(segments, new Map(), agents)
          : body,
      mentioned: [],
      mentionedAgents,
    };
  }

  const rows = (await _db
    .select({
      taskId: tasks.id,
      projectId: tasks.projectId,
      slug: projects.slug,
      key: projects.taskKey,
      number: tasks.number,
    })
    .from(tasks)
    .innerJoin(projects, eq(tasks.projectId, projects.id))
    .where(
      or(
        ...candidates.map((c) =>
          and(eq(projects.taskKey, c.key), eq(tasks.number, c.number)),
        ),
      ),
    )) as Array<{
    taskId: string;
    projectId: string;
    slug: string;
    key: string;
    number: number;
  }>;

  const resolved = new Map<string, ResolvedMention>(
    rows.map((r) => [
      `${r.key}-${r.number}`,
      { slug: r.slug, key: r.key, number: r.number },
    ]),
  );

  log.debug(
    {
      candidates: candidates.length,
      resolved: rows.length,
      agentCandidates: agentCandidates.length,
      agentsResolved: mentionedAgents.length,
    },
    "mentions expanded",
  );

  return {
    expanded: expandResolvedMentions(segments, resolved, agents),
    mentioned: rows.map((r) => ({
      taskId: r.taskId,
      projectId: r.projectId,
      key: r.key,
      number: r.number,
    })),
    mentionedAgents,
  };
}
