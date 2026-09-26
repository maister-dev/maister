import type { LibrarianSubject } from "./types";

// ADR-183 D3: the durable records are the source of truth and the ACP session
// is a cache. Each turn composes a bounded context from the rows it is given;
// this module is pure so the selection is testable without a database.

export type ComposerMessage = {
  id: string;
  seq: bigint;
  authorKind: "owner" | "librarian" | "update" | "system";
  body: string;
};

export type ComposerRevisioned = { id: string; revision: number; text: string };

export type ComposerInput = {
  instructions: string;
  instructionsVersion: string;
  subject: LibrarianSubject | null;
  /** The active segment's earlier messages, in `seq` order. */
  history: ComposerMessage[];
  /** The owner message this turn answers. */
  current: ComposerMessage;
  summaries: ComposerRevisioned[];
  memoryItems: ComposerRevisioned[];
  maxChars: number;
};

export type ComposedContext = {
  prompt: string;
  instructionsVersion: string;
  messageIds: string[];
  summaryRevisions: Record<string, number>;
  memoryItemRevisions: Record<string, number>;
  charCount: number;
  truncated: boolean;
};

function renderMessage(message: ComposerMessage): string {
  return `[${message.authorKind} #${message.seq.toString()}]\n${message.body}`;
}

function renderSubject(subject: LibrarianSubject | null): string | null {
  if (!subject) return null;
  const parts = [
    subject.projectSlug ? `project ${subject.projectSlug}` : null,
    subject.taskIds?.length ? `tasks ${subject.taskIds.join(", ")}` : null,
    subject.runId ? `run ${subject.runId}` : null,
  ].filter((part): part is string => part !== null);

  return parts.length > 0
    ? `The person is looking at: ${parts.join("; ")}.`
    : null;
}

function section(title: string, body: string): string {
  return `## ${title}\n\n${body}`;
}

/** The fixed frame around the variable history: instructions, summaries,
 * memory, the subject and the current message. */
function frame(input: ComposerInput, historyBlock: string | null): string {
  const blocks = [
    input.instructions,
    input.summaries.length > 0
      ? section(
          "Earlier in this conversation (summaries)",
          input.summaries.map((s) => s.text).join("\n\n"),
        )
      : null,
    input.memoryItems.length > 0
      ? section(
          "What this person asked you to remember",
          input.memoryItems.map((m) => `- ${m.text}`).join("\n"),
        )
      : null,
    historyBlock
      ? section("Conversation so far (oldest first)", historyBlock)
      : null,
    renderSubject(input.subject),
    section("Current message", renderMessage(input.current)),
  ].filter((block): block is string => block !== null);

  return blocks.join("\n\n");
}

export function composeLibrarianContext(input: ComposerInput): ComposedContext {
  const fixed = frame(input, null);
  const separator = "\n\n";
  const chosen: ComposerMessage[] = [];
  let used = fixed.length;
  let truncated = false;

  // Newest first until the budget is spent; the rest is left out as a whole
  // message, never cut mid-body.
  for (let i = input.history.length - 1; i >= 0; i -= 1) {
    const rendered = renderMessage(input.history[i]);
    // The history section's heading is paid for by the first message in.
    const cost =
      rendered.length +
      separator.length +
      (chosen.length === 0
        ? "## Conversation so far (oldest first)\n\n".length + separator.length
        : 0);

    if (used + cost > input.maxChars) {
      truncated = true;
      break;
    }
    chosen.unshift(input.history[i]);
    used += cost;
  }
  if (fixed.length > input.maxChars) truncated = true;
  const historyBlock =
    chosen.length > 0 ? chosen.map(renderMessage).join(separator) : null;
  const prompt = frame(input, historyBlock);

  return {
    prompt,
    instructionsVersion: input.instructionsVersion,
    messageIds: [...chosen.map((m) => m.id), input.current.id],
    summaryRevisions: Object.fromEntries(
      input.summaries.map((s) => [s.id, s.revision]),
    ),
    memoryItemRevisions: Object.fromEntries(
      input.memoryItems.map((m) => [m.id, m.revision]),
    ),
    charCount: prompt.length,
    truncated,
  };
}

/** A resumed session already holds the history; the turn sends only what is
 * new — the subject and the current message (the ground-once rule). */
export function composeResumePrompt(input: {
  subject: LibrarianSubject | null;
  current: ComposerMessage;
}): string {
  return [renderSubject(input.subject), renderMessage(input.current)]
    .filter((block): block is string => block !== null)
    .join("\n\n");
}

/** ADR-183 D3 (LIB-13): retained ACP context may be reused only when neither
 * the conversation's context epoch nor the runner changed since the session
 * was created — otherwise it could repeat revoked facts. */
export function decideSessionMode(input: {
  acpSessionId: string | null;
  sessionEpoch: number | null;
  sessionRunnerId: string | null;
  conversationEpoch: number;
  runnerId: string;
}): "resume" | "new" {
  if (!input.acpSessionId || input.sessionEpoch === null) return "new";
  if (input.sessionEpoch !== input.conversationEpoch) return "new";
  if (input.sessionRunnerId !== input.runnerId) return "new";

  return "resume";
}
