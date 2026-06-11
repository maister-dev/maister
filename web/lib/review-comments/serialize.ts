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

// M30 (ADR-078): a gate-chat turn folded into the rework payload — the
// reviewer's questions and the agent's answers are review context.
export interface ComposeChatMessage {
  role: "user" | "agent";
  authorLabel: string;
  body: string;
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
  // M30 (ADR-078): gate-chat history of the deciding review visit, in seq
  // order. Optional — absent/empty keeps the pre-M30 bytes identical.
  chatMessages: readonly ComposeChatMessage[] = [],
): string {
  // D3 backward-compat guarantee: zero open threads AND zero chat ⇒ the raw
  // summary bytes pass through untouched (empty summary included).
  if (threads.length === 0 && chatMessages.length === 0) return summary;

  const blocks: string[] = [];

  if (threads.length > 0) {
    blocks.push("## Review comments");

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
  }

  // M30 (ADR-078): chat turns append AFTER the review-comment threads, in
  // the given (seq) order.
  if (chatMessages.length > 0) {
    blocks.push("## Gate chat");
    for (const msg of chatMessages) {
      blocks.push(`**${msg.authorLabel} (${msg.role}):**`);
      blocks.push(msg.body);
    }
  }

  const threadsSection = blocks.join("\n\n");

  // Only the EMPTY summary collapses to the threads section alone; any other
  // summary joins with a literal \n\n, its bytes untouched (frozen joiner).
  return summary === "" ? threadsSection : `${summary}\n\n${threadsSection}`;
}
