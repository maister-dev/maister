"use client";

import type { ReactElement } from "react";

import { memo, useState } from "react";

import { ReviewCommentComposer } from "@/components/workbench/review-comment-composer";

// TYPE-only mirrors of the review-comment wire DTOs so this client component
// pulls no server code (`@/lib/review-comments/dto.ts` is "server-only").
// Kept structurally in sync with `ReviewCommentDto` there and the
// `ReviewComment` / `ReviewCommentThread` schemas in docs/api/web.openapi.yaml.
export type ReviewCommentSide = "old" | "new";
export type ReviewCommentStatus = "open" | "resolved";
export type ReviewThreadPlacement = "inline" | "outdated";

export type ReviewCommentDto = {
  id: string;
  runId: string;
  hitlRequestId: string;
  nodeId: string;
  gateAttempt: number;
  parentId: string | null;
  authorUserId: string | null;
  authorLabel: string;
  filePath: string | null;
  side: ReviewCommentSide | null;
  line: number | null;
  lineContent: string | null;
  body: string;
  status: ReviewCommentStatus;
  resolvedByUserId: string | null;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string | null;
};

export type ReviewThread = {
  root: ReviewCommentDto;
  placement: ReviewThreadPlacement;
  replies: ReviewCommentDto[];
};

export interface ReviewCommentsLabels {
  composerPlaceholder: string;
  composerSubmit: string;
  composerCancel: string;
  reply: string;
  edit: string;
  delete: string;
  resolve: string;
  unresolve: string;
  resolved: string;
  // `$n` template — house `$count` pattern (see flow-graph-view formatCount).
  iteration: string;
  expand: string;
  collapse: string;
  outdatedTitle: string;
  sideOld: string;
  sideNew: string;
}

export interface ReviewThreadActions {
  onReply: (parentId: string, body: string) => void | Promise<void>;
  onEdit: (commentId: string, body: string) => void | Promise<void>;
  onSetStatus: (
    commentId: string,
    status: ReviewCommentStatus,
  ) => void | Promise<void>;
  onDelete: (commentId: string) => void | Promise<void>;
}

export interface ReviewThreadCardProps {
  thread: ReviewThread;
  currentUserId: string | null;
  canComment: boolean;
  busy?: boolean;
  labels: ReviewCommentsLabels;
  actions: ReviewThreadActions;
}

function ReplyIcon(): ReactElement {
  return (
    <svg
      aria-hidden="true"
      className="shrink-0"
      fill="none"
      height="13"
      viewBox="0 0 16 16"
      width="13"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M6.5 3.5 3 7l3.5 3.5M3 7h7a3 3 0 0 1 3 3v2.5"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.2"
      />
    </svg>
  );
}

function ResolveIcon(): ReactElement {
  return (
    <svg
      aria-hidden="true"
      className="shrink-0"
      fill="none"
      height="13"
      viewBox="0 0 16 16"
      width="13"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="m3.5 8.5 3 3 6-7"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.2"
      />
    </svg>
  );
}

function ReopenIcon(): ReactElement {
  return (
    <svg
      aria-hidden="true"
      className="shrink-0"
      fill="none"
      height="13"
      viewBox="0 0 16 16"
      width="13"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M13.5 8A5.5 5.5 0 1 1 8 2.5c2 0 3.7 1 4.7 2.6"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.2"
      />
      <path
        d="M13 2.5v3h-3"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.2"
      />
    </svg>
  );
}

function EditIcon(): ReactElement {
  return (
    <svg
      aria-hidden="true"
      className="shrink-0"
      fill="none"
      height="13"
      viewBox="0 0 16 16"
      width="13"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="m10 3.5 2.5 2.5-7 7H3v-2.5l7-7Z"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="1.2"
      />
    </svg>
  );
}

function DeleteIcon(): ReactElement {
  return (
    <svg
      aria-hidden="true"
      className="shrink-0"
      fill="none"
      height="13"
      viewBox="0 0 16 16"
      width="13"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M3 4.5h10M6.5 4.5v-2h3v2M4.5 4.5l.5 9h6l.5-9"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.2"
      />
    </svg>
  );
}

function ChevronDownIcon(): ReactElement {
  return (
    <svg
      aria-hidden="true"
      className="shrink-0"
      fill="none"
      height="13"
      viewBox="0 0 16 16"
      width="13"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="m4 6.5 4 4 4-4"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.2"
      />
    </svg>
  );
}

function formatIteration(template: string, attempt: number): string {
  return template.replace("$n", String(attempt));
}

const ICON_BUTTON_CLASS =
  "flex h-6 w-6 shrink-0 items-center justify-center rounded-[6px] text-mute hover:bg-ivory hover:text-ink-2 disabled:opacity-50";

export function ReviewThreadCard({
  thread,
  currentUserId,
  canComment,
  busy = false,
  labels,
  actions,
}: ReviewThreadCardProps): ReactElement {
  const { root, replies } = thread;
  const resolved = root.status === "resolved";
  // Resolved threads start minimized; the owner remounts the card on a
  // status flip (key includes status), so this initial state stays honest.
  const [expanded, setExpanded] = useState(!resolved);
  const [replyOpen, setReplyOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const composerLabels = {
    placeholder: labels.composerPlaceholder,
    submit: labels.composerSubmit,
    cancel: labels.composerCancel,
  };
  const iterationText = formatIteration(labels.iteration, root.gateAttempt);

  const isAuthor = (comment: ReviewCommentDto): boolean =>
    canComment &&
    comment.authorUserId !== null &&
    comment.authorUserId === currentUserId;

  return (
    <div
      className="rounded-[10px] border border-line bg-paper p-2 text-left"
      data-status={root.status}
      data-testid="review-thread"
    >
      <div className="flex items-center gap-1.5">
        {resolved ? (
          <span
            className="rounded-full bg-ivory px-1.5 py-0.5 font-mono text-[10px] font-semibold text-mute"
            data-testid="review-thread-resolved"
          >
            {labels.resolved}
          </span>
        ) : null}
        <span className="truncate font-mono text-[11px] font-semibold text-ink">
          {root.authorLabel}
        </span>
        <span
          aria-label={iterationText}
          className="rounded-full bg-ivory px-1.5 py-0.5 font-mono text-[10px] text-mute"
          data-testid="review-iteration-badge"
          title={iterationText}
        >
          {root.gateAttempt}
        </span>
        <span className="grow" />
        {resolved ? (
          <button
            aria-label={expanded ? labels.collapse : labels.expand}
            className={ICON_BUTTON_CLASS}
            data-testid="review-thread-toggle"
            type="button"
            onClick={() => setExpanded((prev) => !prev)}
          >
            <span className={expanded ? "block rotate-180" : "block"}>
              <ChevronDownIcon />
            </span>
          </button>
        ) : null}
        {canComment ? (
          <>
            <button
              aria-label={labels.reply}
              className={ICON_BUTTON_CLASS}
              data-testid="review-thread-reply"
              disabled={busy}
              type="button"
              onClick={() => setReplyOpen(true)}
            >
              <ReplyIcon />
            </button>
            {resolved ? (
              <button
                aria-label={labels.unresolve}
                className={ICON_BUTTON_CLASS}
                data-testid="review-thread-unresolve"
                disabled={busy}
                type="button"
                onClick={() => void actions.onSetStatus(root.id, "open")}
              >
                <ReopenIcon />
              </button>
            ) : (
              <button
                aria-label={labels.resolve}
                className={ICON_BUTTON_CLASS}
                data-testid="review-thread-resolve"
                disabled={busy}
                type="button"
                onClick={() => void actions.onSetStatus(root.id, "resolved")}
              >
                <ResolveIcon />
              </button>
            )}
            {isAuthor(root) ? (
              <>
                <button
                  aria-label={labels.edit}
                  className={ICON_BUTTON_CLASS}
                  data-testid="review-thread-edit"
                  disabled={busy}
                  type="button"
                  onClick={() => setEditingId(root.id)}
                >
                  <EditIcon />
                </button>
                <button
                  aria-label={labels.delete}
                  className={ICON_BUTTON_CLASS}
                  data-testid="review-thread-delete"
                  disabled={busy}
                  type="button"
                  onClick={() => void actions.onDelete(root.id)}
                >
                  <DeleteIcon />
                </button>
              </>
            ) : null}
          </>
        ) : null}
      </div>
      {expanded ? (
        <div className="mt-1.5 flex flex-col gap-1.5">
          {editingId === root.id ? (
            <ReviewCommentComposer
              busy={busy}
              initialValue={root.body}
              labels={composerLabels}
              onCancel={() => setEditingId(null)}
              onSubmit={async (body) => {
                await actions.onEdit(root.id, body);
                setEditingId(null);
              }}
            />
          ) : (
            <p className="whitespace-pre-wrap font-mono text-[12px] leading-[1.5] text-ink-2">
              {root.body}
            </p>
          )}
          {replies.map((reply) => (
            <div
              key={reply.id}
              className="border-l-2 border-line pl-2"
              data-testid="review-reply"
            >
              <div className="flex items-center gap-1.5">
                <span className="truncate font-mono text-[11px] font-semibold text-ink">
                  {reply.authorLabel}
                </span>
                <span className="grow" />
                {isAuthor(reply) ? (
                  <>
                    <button
                      aria-label={labels.edit}
                      className={ICON_BUTTON_CLASS}
                      data-testid="review-reply-edit"
                      disabled={busy}
                      type="button"
                      onClick={() => setEditingId(reply.id)}
                    >
                      <EditIcon />
                    </button>
                    <button
                      aria-label={labels.delete}
                      className={ICON_BUTTON_CLASS}
                      data-testid="review-reply-delete"
                      disabled={busy}
                      type="button"
                      onClick={() => void actions.onDelete(reply.id)}
                    >
                      <DeleteIcon />
                    </button>
                  </>
                ) : null}
              </div>
              {editingId === reply.id ? (
                <ReviewCommentComposer
                  busy={busy}
                  initialValue={reply.body}
                  labels={composerLabels}
                  onCancel={() => setEditingId(null)}
                  onSubmit={async (body) => {
                    await actions.onEdit(reply.id, body);
                    setEditingId(null);
                  }}
                />
              ) : (
                <p className="whitespace-pre-wrap font-mono text-[12px] leading-[1.5] text-ink-2">
                  {reply.body}
                </p>
              )}
            </div>
          ))}
          {replyOpen ? (
            <ReviewCommentComposer
              busy={busy}
              labels={composerLabels}
              onCancel={() => setReplyOpen(false)}
              onSubmit={async (body) => {
                await actions.onReply(root.id, body);
                setReplyOpen(false);
              }}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// Memoized variant rendered by the inline stack + outdated list. The plain
// `ReviewThreadCard` export stays a function so test `Parameters<typeof>` type
// extraction keeps working; props are stable once the owner memoizes `review`.
export const ReviewThreadCardMemo = memo(ReviewThreadCard);

export interface ReviewThreadStackProps {
  threads: ReviewThread[];
  currentUserId: string | null;
  canComment: boolean;
  busy?: boolean;
  labels: ReviewCommentsLabels;
  actions: ReviewThreadActions;
}

// The renderExtendLine body: every thread anchored to one diff line. Keyed by
// id + status so a resolve/unresolve remounts the card into the right
// collapsed/expanded initial state.
export function ReviewThreadStack({
  threads,
  currentUserId,
  canComment,
  busy = false,
  labels,
  actions,
}: ReviewThreadStackProps): ReactElement | null {
  if (threads.length === 0) return null;

  return (
    <div
      className="flex flex-col gap-2 p-2"
      data-testid="review-inline-threads"
    >
      {threads.map((thread) => (
        <ReviewThreadCardMemo
          key={`${thread.root.id}:${thread.root.status}`}
          actions={actions}
          busy={busy}
          canComment={canComment}
          currentUserId={currentUserId}
          labels={labels}
          thread={thread}
        />
      ))}
    </div>
  );
}
