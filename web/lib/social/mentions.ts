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

const MENTION_TOKEN = /\b([A-Z][A-Z0-9]{1,9})-(\d+)\b/g;
const PG_INT4_MAX = 2_147_483_647;

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
    for (const match of segment.value.matchAll(MENTION_TOKEN)) {
      const key = match[1];
      const number = Number.parseInt(match[2], 10);

      if (number < 1 || number > PG_INT4_MAX) continue;

      const token = `${key}-${number}`;

      if (seen.has(token)) continue;
      seen.add(token);
      candidates.push({ key, number });
    }
  }

  return candidates;
}

export type ResolvedMention = {
  slug: string;
  key: string;
  number: number;
};

export function expandResolvedMentions(
  segments: MarkdownSegment[],
  resolved: Map<string, ResolvedMention>,
): string {
  return segments
    .map((segment) => {
      if (segment.kind !== "text") return segment.value;

      return segment.value.replace(
        MENTION_TOKEN,
        (token, key: string, num: string) => {
          const hit = resolved.get(`${key}-${Number.parseInt(num, 10)}`);

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
};

export async function expandMentions(
  body: string,
  db?: Db,
): Promise<ExpandedMentions> {
  const _db = (db ?? getDb()) as unknown as { select: any };
  const segments = segmentMarkdown(body);
  const candidates = collectMentionCandidates(segments);

  if (candidates.length === 0) {
    return { expanded: body, mentioned: [] };
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
    { candidates: candidates.length, resolved: rows.length },
    "mentions expanded",
  );

  return {
    expanded: expandResolvedMentions(segments, resolved),
    mentioned: rows.map((r) => ({
      taskId: r.taskId,
      projectId: r.projectId,
      key: r.key,
      number: r.number,
    })),
  };
}
