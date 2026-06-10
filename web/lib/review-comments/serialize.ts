import { compareThreadReplies, compareThreadRoots } from "./order";

// ADR-072 rework-payload composer. The serialization format is FROZEN in
// docs/system-analytics/review-comments.md — change the doc before changing
// one byte here. Pure module: no DB, fs, or logger imports.
//
// Input shapes are minimal structural subsets of the review_comments row so
// the runner can pass the service's listThreads output directly without
// pulling the DB module graph into this file. Resolved-thread exclusion is
// the CALLER's contract (D3): this composer serializes every thread it is
// given — feed it OPEN roots only.

export interface ComposeRootComment {
  id: string;
  filePath: string | null;
  side: "old" | "new" | null;
  line: number | null;
  lineContent: string | null;
  authorLabel: string;
  body: string;
  createdAt: Date;
}

export interface ComposeReplyComment {
  id: string;
  authorLabel: string;
  body: string;
  createdAt: Date;
}

export interface ComposeThread {
  root: ComposeRootComment;
  replies: readonly ComposeReplyComment[];
}

function quoteLineContent(content: string): string {
  return content
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

export function composeReworkPayload(
  summary: string,
  threads: readonly ComposeThread[],
): string {
  // D3 backward-compat guarantee: zero open threads ⇒ the raw summary bytes
  // pass through untouched (empty summary included).
  if (threads.length === 0) return summary;

  const blocks: string[] = ["## Review comments"];

  // Sort defensively so the output is deterministic regardless of input
  // order; copies keep the function pure (inputs are never mutated).
  const orderedThreads = [...threads].sort((a, b) =>
    compareThreadRoots(a.root, b.root),
  );

  for (const thread of orderedThreads) {
    const { root } = thread;

    // Anchor fields are non-null on roots (DB CHECK); the fallbacks only
    // keep the composer total over the structural row type.
    blocks.push(
      `### ${root.filePath ?? ""}:${root.line ?? 0} (${root.side ?? "new"})`,
    );
    blocks.push(quoteLineContent(root.lineContent ?? ""));
    blocks.push(`**${root.authorLabel}:**`);
    blocks.push(root.body);

    for (const reply of [...thread.replies].sort(compareThreadReplies)) {
      blocks.push(`**Reply — ${reply.authorLabel}:**`);
      blocks.push(reply.body);
    }
  }

  const threadsSection = blocks.join("\n\n");

  // Only the EMPTY summary collapses to the threads section alone; any other
  // summary joins with a literal \n\n, its bytes untouched (frozen joiner).
  return summary === "" ? threadsSection : `${summary}\n\n${threadsSection}`;
}
